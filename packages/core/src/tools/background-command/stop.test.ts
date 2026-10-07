import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { it } from 'node:test'
import { localWorkspaceIO } from '../../workspace/io.ts'
import type { WorkspaceProcess } from '../../workspace/process.ts'
import {
  createCommandTools,
  GET_COMMAND_OUTPUT_TOOL_NAME,
  LIST_COMMANDS_TOOL_NAME,
  STOP_COMMAND_TOOL_NAME,
} from './index.ts'
import { CommandSessionManager } from './manager.ts'
import type { CommandTaskTerminalNotification } from './types.ts'

const SESSION = '11111111-1111-4111-8111-111111111111'
const stopCases = [
  { reason: 'model', emitClose: true, confirmed: true, detail: '模型主动停止' },
  { reason: 'model', emitClose: false, confirmed: true, detail: '模型主动停止' },
  { reason: 'model', emitClose: false, confirmed: false, detail: '模型主动停止；未能确认全部子进程均已终止' },
  { reason: 'timeout', emitClose: true, confirmed: true, detail: '后台命令超时，已请求终止进程树' },
  { reason: 'timeout', emitClose: false, confirmed: true, detail: '后台命令超时，已请求终止进程树' },
  { reason: 'shutdown', emitClose: true, confirmed: true, detail: '应用退出时已终止' },
  { reason: 'shutdown', emitClose: false, confirmed: true, detail: '应用退出时已终止' },
  { reason: 'exit', emitClose: true, confirmed: true, detail: '退出码 17' },
] as const

for (const scenario of stopCases) {
  it(`停止归因贯穿工具、菜单和重启：${scenario.reason} close=${scenario.emitClose} confirmed=${scenario.confirmed}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-command-stop-'))
    let terminateCalls = 0
    const child: WorkspaceProcess = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      async terminate() {
        terminateCalls++
        child.exitCode = 143
        if (scenario.emitClose) child.emit('close', child.exitCode)
        return scenario.confirmed
      },
    })
    const notifications: CommandTaskTerminalNotification[] = []
    const manager = new CommandSessionManager(root, {
      onBackgroundTaskTerminal: notification => notifications.push(notification),
    })
    let reopened: CommandSessionManager | undefined
    t.after(async () => {
      await reopened?.shutdown()
      await manager.shutdown()
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    })

    const started = await manager.start({
      sessionId: SESSION, command: 'long-running-command', cwd: root,
      timeoutMs: scenario.reason === 'timeout' ? 100 : undefined,
      workspaceIO: {
        ...localWorkspaceIO,
        spawn: () => {
          queueMicrotask(() => child.emit('spawn'))
          return child
        },
      },
    })
    await manager.armTerminalNotification(SESSION, started.id)
    const ctx = { projectDir: root, additionalDirs: [], abortSignal: new AbortController().signal }
    const stop = createCommandTools(manager, SESSION).taskTools.find(tool => tool.name === STOP_COMMAND_TOOL_NAME)!
    if (scenario.reason === 'model') {
      // 重复请求共用首次停止，不能在等待进程退出时改写原因或重复终止。
      const results = await Promise.all([
        stop.execute({ taskId: started.id }, ctx),
        stop.execute({ taskId: started.id }, ctx),
      ])
      assert.deepEqual(results[0], results[1])
      assert.equal(results[0].isError, false)
      assert.ok(results[0].data.includes(scenario.detail))
    } else if (scenario.reason === 'shutdown') {
      await manager.shutdown()
    } else {
      if (scenario.reason === 'exit') child.emit('close', 17)
      await manager.readOutput(SESSION, started.id, 0, 1024, 5_000)
    }

    await manager.shutdown()
    const [terminal] = await manager.list(SESSION)
    assert.ok(terminal)
    assert.equal(terminal.status, scenario.reason === 'timeout' || scenario.reason === 'exit' ? 'failed' : 'stopped')
    assert.equal(terminal.failureReason, scenario.detail)
    const repeated = await stop.execute({ taskId: started.id }, ctx)
    assert.ok(repeated.data.includes(scenario.detail))
    assert.deepEqual((await manager.list(SESSION))[0], terminal)
    assert.equal(terminateCalls, scenario.reason === 'exit' ? 0 : 1)
    assert.equal(notifications.length, terminal.status === 'failed' ? 1 : 0)

    reopened = new CommandSessionManager(root)
    for (const current of [manager, reopened]) {
      const taskTools = createCommandTools(current, SESSION).taskTools
      const list = await taskTools.find(tool => tool.name === LIST_COMMANDS_TOOL_NAME)!.execute({}, ctx)
      const output = await taskTools.find(tool => tool.name === GET_COMMAND_OUTPUT_TOOL_NAME)!.execute({ taskId: started.id }, ctx)
      for (const result of [list, output]) {
        assert.ok(result.data.includes(scenario.detail))
        assert.doesNotMatch(result.data, /用户已停止/)
      }
      const state = await current.backgroundTasks(SESSION)
      assert.equal(state.tasks[0]?.detail, scenario.detail)
      assert.equal(state.tasks[0]?.status, terminal.status)
      assert.deepEqual((await current.list(SESSION))[0], terminal)
    }
  })
}
