import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { it, type TestContext } from 'node:test'
import { localWorkspaceIO } from '../../workspace/io.ts'
import type { WorkspaceProcess } from '../../workspace/process.ts'
import { createCommandTools, GET_COMMAND_OUTPUT_TOOL_NAME } from './index.ts'
import { CommandSessionManager } from './manager.ts'
import type { BackgroundTaskState, CommandTaskTerminalNotification } from './types.ts'

const SESSION = '11111111-1111-4111-8111-111111111111'
const OTHER_SESSION = '22222222-2222-4222-8222-222222222222'

for (const wakeOnCompletion of [false, true]) {
  it(`用户停止只通知一次并持久保留来源，wakeOnCompletion=${wakeOnCompletion}`, async t => {
    const env = await fixture(t)
    if (wakeOnCompletion) await env.manager.armTerminalNotification(SESSION, env.task.id, 'plan-id')
    const [stopped, concurrent] = await Promise.all([
      env.manager.stop(SESSION, env.task.id, { source: 'user' }),
      env.manager.stop(SESSION, env.task.id, { source: 'model', detail: '不能覆盖用户原因' }),
    ])
    assert.deepEqual(stopped, concurrent)
    assert.equal(stopped.status, 'stopped')
    assert.equal(stopped.failureReason, '用户主动停止')
    assert.equal(env.terminateCalls(), 1)
    assert.equal(env.notifications.length, 1)
    assert.deepEqual(env.notifications[0]?.task, stopped)
    assert.equal(env.notifications[0]?.engagedPlanId, wakeOnCompletion ? 'plan-id' : undefined)
    assert.equal(env.manager.hasPendingPlanContinuation(SESSION, 'plan-id'), false)
    assert.deepEqual(env.states.map(s => s.tasks[0]?.status).filter((status, i, values) => status !== values[i - 1]),
      ['running', 'stopping', 'stopped'])

    assert.deepEqual(await env.manager.stop(SESSION, env.task.id, { source: 'user' }), stopped)
    assert.equal(env.notifications.length, 1)
    const reopened = new CommandSessionManager(env.root)
    assert.deepEqual((await reopened.list(SESSION))[0], stopped)
    assert.equal((await reopened.backgroundTasks(SESSION)).tasks[0]?.detail, '用户主动停止')
    await reopened.shutdown()
  })
}

it('手动停止按所属会话隔离，不接受其它会话的任务', async t => {
  const env = await fixture(t)
  await assert.rejects(env.manager.stop(OTHER_SESSION, env.task.id, { source: 'user' }), /当前会话不存在/)
  assert.equal(env.terminateCalls(), 0)
  assert.equal((await env.manager.list(SESSION))[0]?.status, 'running')
  assert.equal(env.notifications.length, 0)
})

it('停止在途状态来自管理器，禁止 stdin，并发请求共用首次停止', async t => {
  const entered = deferred()
  const release = deferred()
  const env = await fixture(t, async child => {
    entered.resolve()
    await release.promise
    finish(child, 143)
    return true
  })
  const stopping = env.manager.stop(SESSION, env.task.id, { source: 'user' })
  await entered.promise
  const snapshot = (await env.manager.list(SESSION))[0]!
  assert.equal(snapshot.status, 'stopping')
  assert.equal(snapshot.canWrite, false)
  assert.equal(snapshot.endedAt, undefined)
  await assert.rejects(env.manager.writeInput(SESSION, env.task.id, 'unexpected'), /已不接受输入/)
  const duplicate = env.manager.stop(SESSION, env.task.id, { source: 'model' })
  release.resolve()
  assert.deepEqual(await duplicate, await stopping)
  assert.equal(env.terminateCalls(), 1)
  assert.equal(env.notifications.length, 1)
})

it('未确认进程退出不假报成功或通知，恢复操作入口后可重试', async t => {
  let allowStop = false
  const env = await fixture(t, async child => {
    if (allowStop) finish(child, 143)
    return allowStop
  })
  await assert.rejects(env.manager.stop(SESSION, env.task.id, { source: 'user' }), /未能确认后台命令已停止/)
  assert.equal((await env.manager.list(SESSION))[0]?.status, 'running')
  assert.equal(env.notifications.length, 0)
  allowStop = true
  assert.equal((await env.manager.stop(SESSION, env.task.id, { source: 'user' })).status, 'stopped')
  assert.equal(env.terminateCalls(), 2)
  assert.equal(env.notifications.length, 1)
})

for (const code of [0, 17]) {
  it(`确认前已退出的任务保留原结果，不归因到用户：${code}`, async t => {
    const env = await fixture(t)
    // exitCode 已就绪而 close 还在排空输出时，也不应发送终止请求。
    env.child.exitCode = code
    const stopped = env.manager.stop(SESSION, env.task.id, { source: 'user' })
    await setImmediate()
    env.child.stdout.write('last output')
    env.child.emit('close', code)
    const terminal = await stopped
    assert.equal(terminal.status, code === 0 ? 'completed' : 'failed')
    assert.equal(terminal.failureReason, code === 0 ? undefined : '退出码 17')
    assert.equal(env.terminateCalls(), 0)
    assert.equal(env.notifications.length, 0)
    assert.equal((await env.manager.readOutput(SESSION, env.task.id)).output, 'last output')
  })
}

it('停止请求期间自然成功退出保留 completed，不报告用户终止', async t => {
  const env = await fixture(t, async child => { finish(child, 0); return false })
  const terminal = await env.manager.stop(SESSION, env.task.id, { source: 'user' })
  assert.equal(terminal.status, 'completed')
  assert.equal(terminal.failureReason, undefined)
  assert.equal(env.notifications.length, 0)
})

it('接受终止后以退出码 0 收尾仍属于用户停止，不冒充自然完成', async t => {
  const env = await fixture(t, async child => { finish(child, 0); return true })
  const terminal = await env.manager.stop(SESSION, env.task.id, { source: 'user' })
  assert.equal(terminal.status, 'stopped')
  assert.equal(terminal.failureReason, '用户主动停止')
  assert.equal(env.notifications.length, 1)
})

it('GetCommandOutput 等待中直接得到用户停止终态时不重复续轮', async t => {
  const env = await fixture(t)
  await env.manager.armTerminalNotification(SESSION, env.task.id)
  const output = createCommandTools(env.manager, SESSION).taskTools.find(t => t.name === GET_COMMAND_OUTPUT_TOOL_NAME)!
  const reading = output.execute({ taskId: env.task.id, waitMs: 30_000 }, {
    projectDir: env.root, additionalDirs: [], abortSignal: new AbortController().signal,
  })
  await setImmediate()
  await env.manager.stop(SESSION, env.task.id, { source: 'user' })
  const result = await reading
  assert.match(result.data, /状态：stopped/)
  assert.match(result.data, /用户主动停止/)
  assert.match(output.prompt, /不要自行重启/)
  assert.equal(env.notifications.length, 0)
})

for (const endWait of ['timeout', 'abort', 'output'] as const) {
  it(`未读到终态的 ${endWait} 等待不能吞掉稍后的用户停止通知`, async t => {
    const env = await fixture(t)
    const abort = new AbortController()
    const reading = env.manager.readOutput(SESSION, env.task.id, 0, 1024, endWait === 'timeout' ? 1 : 30_000, abort.signal)
    await setImmediate()
    if (endWait === 'abort') {
      abort.abort()
      await assert.rejects(reading, { name: 'AbortError' })
    } else {
      if (endWait === 'output') env.child.stdout.write('progress')
      assert.equal((await reading).task.status, 'running')
    }
    await env.manager.stop(SESSION, env.task.id, { source: 'user' })
    assert.equal(env.notifications.length, 1)
  })
}

it('模型先停止时保留模型原因；应用退出清理均不产生用户通知', async t => {
  const env = await fixture(t)
  await env.manager.armTerminalNotification(SESSION, env.task.id)
  const [model, user] = await Promise.all([
    env.manager.stop(SESSION, env.task.id, { source: 'model', detail: '完成检查' }),
    env.manager.stop(SESSION, env.task.id, { source: 'user' }),
  ])
  assert.deepEqual(model, user)
  assert.equal(model.failureReason, '模型主动停止：完成检查')
  assert.equal(env.manager.hasPendingPlanContinuation(SESSION, 'plan-id'), false)
  assert.equal(env.notifications.length, 0)

  const shutdown = await fixture(t)
  await shutdown.manager.armTerminalNotification(SESSION, shutdown.task.id)
  await shutdown.manager.shutdown()
  assert.equal((await shutdown.manager.list(SESSION))[0]?.failureReason, '应用退出时已终止')
  assert.equal(shutdown.notifications.length, 0)
})

async function fixture(t: TestContext, terminate?: (child: WorkspaceProcess) => Promise<boolean>) {
  const root = await mkdtemp(join(tmpdir(), 'whycode-user-stop-'))
  let calls = 0
  const child: WorkspaceProcess & { stdout: PassThrough; stderr: PassThrough } = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    async terminate() {
      calls++
      if (terminate) return terminate(child)
      finish(child, 143)
      return true
    },
  })
  const notifications: CommandTaskTerminalNotification[] = []
  const states: BackgroundTaskState[] = []
  const manager = new CommandSessionManager(root, {
    onBackgroundTaskTerminal: n => notifications.push(n),
    onBackgroundTasksChanged: state => states.push(state),
  })
  t.after(async () => {
    if (child.exitCode === null) finish(child, 143)
    await manager.shutdown()
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const task = await manager.start({
    sessionId: SESSION, command: 'long-running-command', cwd: root,
    workspaceIO: { ...localWorkspaceIO, spawn: () => { queueMicrotask(() => child.emit('spawn')); return child } },
  })
  return { root, manager, task, child, notifications, states, terminateCalls: () => calls }
}

function finish(child: WorkspaceProcess, code: number) {
  child.exitCode = code
  child.emit('close', code)
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
