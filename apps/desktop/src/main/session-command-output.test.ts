import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { it } from 'node:test'
import { AgentSession, localWorkspace, toViewEvent, type CoreEvent, type ViewEvent } from '@whycode/core'
import { readCommandOutputResult } from '@whycode/core/command-output'
import { toolCallDetails } from '../shared/tool-call-summary.ts'
import { DesktopSessionRepository } from './session-repository.ts'
import { SessionScratchManager } from './session-scratch.ts'
import { stageSessionDeletion } from './session-deletion.ts'
import { finalStream, languageModel, modelEntry, toolStream } from './subagent-test-fixture.ts'

it('长命令日志经模型工具读取、恢复和 Fork 保留，删除会话只清理自己的日志', { timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'whycode-session-command-output-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  await mkdir(project)
  const script = join(project, 'output.cjs')
  await writeFile(script, "process.stdout.write(Array.from({length:6000}, (_,i) => `line-${i}: 中文😀`).join(String.fromCharCode(10)) + String.fromCharCode(10))")
  const command = process.platform === 'win32'
    ? `& '${process.execPath.replaceAll("'", "''")}' '${script.replaceAll("'", "''")}'`
    : `'${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}'`
  const sessions = new DesktopSessionRepository(join(root, 'sessions'))
  const journal = await sessions.create(localWorkspace(project), 'test:subagent')
  const scratchRoot = join(root, 'scratch')
  const scratch = new SessionScratchManager(scratchRoot)
  const paths = await scratch.ensure(journal.sessionId)
  let calls = 0
  let log = ''
  let toolData = ''
  const events: CoreEvent[] = []
  const session = new AgentSession({
    model: modelEntry(languageModel(async options => {
      calls++
      if (calls === 1) return toolStream('RunCommand', { command }, 'command')
      if (calls === 2) {
        const event = events.find(event => event.type === 'tool-end' && event.toolUseId === 'command')
        assert.ok(event?.type === 'tool-end' && !event.isError, JSON.stringify(event))
        assert.match(JSON.stringify(options.prompt), /fullOutputPath/)
        toolData = String(event.result)
        log = readCommandOutputResult(toolData)!.fullOutputPath!
        return toolStream('ReadFile', { path: log, offset: 2001, limit: 2 }, 'read-log')
      }
      assert.match(JSON.stringify(options.prompt), /line-2000: 中文😀/)
      return finalStream('已找到中间日志')
    })),
    providerConfig: { apiKey: 'fixture-only' }, sessionRecorder: journal,
    promptContext: { projectDir: project, osPlatform: process.platform,
      scratch: { rootDir: paths.rootDirectory, workingDir: paths.mainDirectory } },
    emit: event => events.push(event), requestApproval: async () => ({ approved: true }),
  })
  t.after(() => session.dispose())
  await journal.recordUserInput('检查构建日志', true)
  const outcome = await session.handleUserMessage('检查构建日志')
  assert.equal(outcome, 'completed', JSON.stringify(events.filter(event => event.type === 'error' || event.type === 'tool-end')))
  await session.dispose()
  assert.equal(calls, 3)
  const turn = events.find(event => event.type === 'turn-start')
  assert.ok(turn?.type === 'turn-start')
  await journal.recordViewEvents([
    ...events.map(toViewEvent).filter((event): event is ViewEvent => event !== null),
    { type: 'core-event', event: { type: 'work-finished', durationMs: 1, outcome: 'completed', forkTurnId: turn.turnId } },
  ])
  const full = await readFile(log, 'utf8')
  assert.match(full, /line-0: 中文😀/)
  assert.match(full, /line-2000: 中文😀/)
  assert.match(full, /line-5999: 中文😀/)
  const details = toolCallDetails('RunCommand', { command }, toolData, false)!
  assert.match(details, /完整日志/)
  assert.ok(details.includes(log))
  assert.doesNotMatch(details, /"type":"command-output"/)
  const reopened = await new DesktopSessionRepository(join(root, 'sessions')).prepareResume(journal.sessionId)
  assert.ok(JSON.stringify(reopened.initialMessages).includes('fullOutputPath'))
  const fork = await sessions.fork(journal, turn.turnId, scratchRoot)
  const forkPaths = await scratch.snapshot(journal.sessionId, fork.sessionId)
  const copiedLog = join(forkPaths.mainDirectory, 'command-output', basename(log))
  const card = fork.initialViewEvents.find(value => value.type === 'core-event' && value.event.type === 'tool-end' && value.event.toolUseId === 'command')
  assert.ok(card?.type === 'core-event' && card.event.type === 'tool-end')
  assert.equal(readCommandOutputResult(String(card.event.result))!.fullOutputPath, copiedLog)
  const commandSessions = { removeSession: async () => {} }
  await (await stageSessionDeletion({ sessionId: journal.sessionId, sessions, scratch, commandSessions })).finish()
  await assert.rejects(access(log), { code: 'ENOENT' })
  assert.equal(await readFile(copiedLog, 'utf8'), full)
  await access(script)
  await (await stageSessionDeletion({ sessionId: fork.sessionId, sessions, scratch, commandSessions })).finish()
  await assert.rejects(access(copiedLog), { code: 'ENOENT' })
  await access(script)
})
