import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createBackgroundCommandTools, START_COMMAND_TOOL_NAME } from './index.ts'
import { CommandSessionManager } from './manager.ts'
import type { CommandOutputChunk, CommandTaskSnapshot } from './types.ts'

const SESSION_A = '11111111-1111-4111-8111-111111111111'
const SESSION_B = '22222222-2222-4222-8222-222222222222'

function quote(path: string): string {
  return `"${path.replaceAll('"', '\\"')}"`
}

async function createFixture(script: string): Promise<{
  root: string
  cwd: string
  storage: string
  command: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'whycode-background-command-'))
  const cwd = join(root, 'workspace')
  const storage = join(root, 'tasks')
  await writeFile(join(root, 'placeholder'), '')
  await mkdir(cwd)
  const scriptPath = join(cwd, 'runner.mjs')
  await writeFile(scriptPath, script)
  const invocation = `${quote(process.execPath)} ${quote(scriptPath)}`
  return {
    root,
    cwd,
    storage,
    command: process.platform === 'win32' ? `& ${invocation}` : invocation,
  }
}

async function waitForTerminal(
  manager: CommandSessionManager,
  taskId: string,
  offset = 0,
): Promise<CommandOutputChunk> {
  const deadline = Date.now() + 10_000
  let currentOffset = offset
  let output = ''
  while (Date.now() < deadline) {
    const chunk = await manager.readOutput(SESSION_A, taskId, currentOffset, 32_768, 500)
    output += chunk.output
    currentOffset = chunk.nextOffset
    if (chunk.task.status !== 'running') return { ...chunk, output, offset }
  }
  throw new Error('后台命令未在测试时限内结束')
}

describe('后台命令会话', () => {
  it('增量读取输出并在进程结束后保留可恢复终态', async () => {
    const fixture = await createFixture(
      `process.stdout.write('first\\n')\nsetTimeout(() => process.stdout.write('second\\n'), 50)`,
    )
    const manager = new CommandSessionManager(fixture.storage)
    try {
      const started = await manager.start({
        sessionId: SESSION_A,
        command: fixture.command,
        cwd: fixture.cwd,
      })
      const completed = await waitForTerminal(manager, started.id)
      assert.equal(completed.task.status, 'completed')
      assert.match(completed.output, /first/)
      assert.match(completed.output, /second/)

      await manager.shutdown()
      const reopened = new CommandSessionManager(fixture.storage)
      await reopened.initialize()
      const restored = await reopened.list(SESSION_A)
      assert.equal(restored[0]?.status, 'completed')
      const replay = await reopened.readOutput(SESSION_A, started.id)
      assert.match(replay.output, /first/)
      assert.match(replay.output, /second/)
    } finally {
      await manager.shutdown()
      await rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

  it('支持 stdin、完整进程树停止，并隔离不同会话的任务 ID', async () => {
    const fixture = await createFixture(`
      process.stdout.write('ready\\n')
      process.stdin.once('data', data => process.stdout.write('input:' + data.toString().trim() + '\\n'))
      setInterval(() => {}, 1000)
    `)
    const manager = new CommandSessionManager(fixture.storage)
    try {
      const started = await manager.start({
        sessionId: SESSION_A,
        command: fixture.command,
        cwd: fixture.cwd,
      })
      const first = await manager.readOutput(SESSION_A, started.id, 0, 32_768, 5_000)
      assert.match(first.output, /ready/)

      const afterInput = await manager.writeInput(SESSION_A, started.id, 'hello\n', true)
      assert.equal(afterInput.canWrite, false)
      const second = await manager.readOutput(
        SESSION_A,
        started.id,
        first.nextOffset,
        32_768,
        5_000,
      )
      assert.match(second.output, /input:hello/)
      await assert.rejects(() => manager.readOutput(SESSION_B, started.id), /当前会话不存在/)

      const stopped = await manager.stop(SESSION_A, started.id)
      assert.equal(stopped.status, 'stopped')
      assert.equal((await manager.list(SESSION_A)).length, 1)
    } finally {
      await manager.shutdown()
      await rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

  it('启动时把崩溃遗留的 running 清晰恢复为 interrupted', async () => {
    const fixture = await createFixture(`process.stdout.write('ready\\n'); setInterval(() => {}, 1000)`)
    const manager = new CommandSessionManager(fixture.storage)
    try {
      const started = await manager.start({
        sessionId: SESSION_A,
        command: fixture.command,
        cwd: fixture.cwd,
      })
      await manager.readOutput(SESSION_A, started.id, 0, 32_768, 5_000)
      await manager.shutdown()

      const sessionDir = join(fixture.storage, SESSION_A)
      const manifestName = (await readdir(sessionDir)).find((name) => name.endsWith('.json'))
      assert.ok(manifestName)
      const manifestPath = join(sessionDir, manifestName)
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as CommandTaskSnapshot
      assert.equal(manifest.status, 'stopped', 'shutdown 返回前必须持久化终态')
      await writeFile(
        manifestPath,
        JSON.stringify({
          ...manifest,
          status: 'running',
          endedAt: undefined,
          failureReason: undefined,
        }),
      )

      const reopened = new CommandSessionManager(fixture.storage)
      await reopened.initialize()
      const interrupted = (await reopened.list(SESSION_A)).find((task) => task.id === started.id)
      assert.equal(interrupted?.status, 'interrupted')
      assert.match(interrupted?.failureReason ?? '', /无法安全重连/)
    } finally {
      await manager.shutdown()
      await rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

  it('只给普通 Main 暴露五个职责清晰的会话工具', () => {
    const manager = new CommandSessionManager('unused')
    const tools = createBackgroundCommandTools(manager, SESSION_A)
    assert.equal(new Set(tools.map((tool) => tool.name)).size, 5)
    const start = tools.find((tool) => tool.name === START_COMMAND_TOOL_NAME)
    assert.ok(start)
    assert.equal(start.kind, 'execute')
    assert.equal(start.checkpointScope, undefined)
  })
})
