import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  createCommandTools,
  STOP_COMMAND_TOOL_NAME,
  WRITE_COMMAND_INPUT_TOOL_NAME,
} from './index.ts'
import { RUN_COMMAND_TOOL_NAME } from '../run-command/index.ts'
import { CommandSessionManager } from './manager.ts'
import type {
  BackgroundTaskState,
  CommandOutputChunk,
  CommandTaskSnapshot,
  CommandTaskTerminalNotification,
} from './types.ts'

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

  it('只给普通会话暴露五个职责清晰的命令工具', () => {
    const manager = new CommandSessionManager('unused')
    const commands = createCommandTools(manager, SESSION_A)
    const tools = [commands.runCommand, ...commands.taskTools]
    assert.equal(new Set(tools.map((tool) => tool.name)).size, 5)
    const run = tools.find((tool) => tool.name === RUN_COMMAND_TOOL_NAME)
    const writeInput = tools.find((tool) => tool.name === WRITE_COMMAND_INPUT_TOOL_NAME)
    const stop = tools.find((tool) => tool.name === STOP_COMMAND_TOOL_NAME)
    assert.ok(run)
    assert.ok(writeInput)
    assert.ok(stop)
    assert.equal(run.kind, 'execute')
    assert.equal(writeInput.kind, 'execute')
    assert.equal(stop.kind, 'control')
    assert.equal(run.checkpointScope, undefined)
    assert.match(run.prompt, /runInBackground=true/)
  })

  it('前台命令等待终态且不登记任务，只有显式后台进程进入任务管理器', async () => {
    const finite = await createFixture(
      `process.stdout.write('installing\\n'); setTimeout(() => process.stdout.write('ready\\n'), 50)`,
    )
    const manager = new CommandSessionManager(finite.storage)
    try {
      const run = createCommandTools(manager, SESSION_A).runCommand
      let progress = ''
      const result = await run.execute({
        command: finite.command,
        cwd: finite.cwd,
      }, {
        projectDir: finite.cwd,
        additionalDirs: [],
        abortSignal: new AbortController().signal,
        onProgress: (output) => { progress += output },
      })
      assert.equal(result.isError, false)
      assert.match(result.data, /ready/)
      assert.match(progress, /installing/)
      assert.match(progress, /ready/)
      assert.equal((await manager.list(SESSION_A)).length, 0)

      const persistentFixture = await createFixture(
        `process.stdout.write('server ready\\n'); setInterval(() => {}, 1000)`,
      )
      try {
        const background = await run.execute({
          command: persistentFixture.command,
          cwd: persistentFixture.cwd,
          runInBackground: true,
        }, {
          projectDir: persistentFixture.cwd,
          additionalDirs: [],
          abortSignal: new AbortController().signal,
        })
        assert.match(background.data, /状态：running/)
        assert.match(background.data, /不会在终态自动通知你/)
        const running = (await manager.list(SESSION_A)).find((item) => item.status === 'running')
        assert.ok(running)
        const projected = (await manager.backgroundTasks(SESSION_A)).tasks
          .find((task) => task.id === running.id)
        assert.equal(projected?.status, 'running')
        assert.equal(projected?.wakeOnCompletion, false)
        const ready = await manager.readOutput(SESSION_A, running.id, 0, 32_768, 5_000)
        assert.match(ready.output, /server ready/)
        await manager.stop(SESSION_A, running.id)
      } finally {
        await rm(persistentFixture.root, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        })
      }
    } finally {
      await manager.shutdown()
      await rm(finite.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

  it('只有显式登记的后台任务自然结束后通知一次，用户停止不通知', async () => {
    const fixture = await createFixture(
      `process.stdout.write('started\\n'); setTimeout(() => process.stdout.write('done\\n'), 100)`,
    )
    const notifications: CommandTaskTerminalNotification[] = []
    const manager = new CommandSessionManager(fixture.storage, {
      onBackgroundTaskTerminal: (notification) => notifications.push(notification),
    })
    try {
      const run = createCommandTools(manager, SESSION_A).runCommand
      const silent = await run.execute({
        command: fixture.command,
        cwd: fixture.cwd,
        runInBackground: true,
      }, {
        projectDir: fixture.cwd,
        additionalDirs: [],
        abortSignal: new AbortController().signal,
      })
      assert.match(silent.data, /不会在终态自动通知你/)
      const silentTask = (await manager.list(SESSION_A)).find((task) =>
        task.command === fixture.command,
      )
      assert.ok(silentTask)
      assert.equal((await waitForTerminal(manager, silentTask.id)).task.status, 'completed')
      assert.equal(notifications.length, 0)

      const notifying = await run.execute({
        command: fixture.command,
        cwd: fixture.cwd,
        runInBackground: true,
        wakeOnCompletion: true,
      }, {
        projectDir: fixture.cwd,
        additionalDirs: [],
        abortSignal: new AbortController().signal,
        engagedPlanId: '33333333-3333-4333-8333-333333333333',
      })
      assert.match(notifying.data, /通知你并自动继续/)
      const running = (await manager.list(SESSION_A)).find((task) => task.status === 'running')
      assert.ok(running)
      assert.equal(
        manager.hasPendingPlanContinuation(
          SESSION_A,
          '33333333-3333-4333-8333-333333333333',
        ),
        true,
      )
      const completed = await waitForTerminal(manager, running.id)
      assert.equal(completed.task.status, 'completed')
      assert.equal(
        manager.hasPendingPlanContinuation(
          SESSION_A,
          '33333333-3333-4333-8333-333333333333',
        ),
        false,
      )
      assert.equal(notifications.length, 1)
      assert.equal(notifications[0]?.task.id, running.id)
      assert.equal(notifications[0]?.engagedPlanId, '33333333-3333-4333-8333-333333333333')

      // 用一个足够长但最终会自行退出的进程验证“用户停止”分支，避免测试失败时留下孤儿进程。
      const persistent = await createFixture(`setTimeout(() => {}, 2_000)`)
      try {
        const stoppedStart = await run.execute({
          command: persistent.command,
          cwd: persistent.cwd,
          runInBackground: true,
          wakeOnCompletion: true,
        }, {
          projectDir: persistent.cwd,
          additionalDirs: [],
          abortSignal: new AbortController().signal,
        })
        assert.match(stoppedStart.data, /状态：running/)
        const stoppedTask = (await manager.list(SESSION_A)).find((task) =>
          task.status === 'running' && task.id !== running.id)
        assert.ok(stoppedTask)
        await manager.stop(SESSION_A, stoppedTask.id)
        assert.equal(notifications.length, 1)
      } finally {
        await rm(persistent.root, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        })
      }
    } finally {
      await manager.shutdown()
      await rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

  it('投影全部后台命令，并独立标记终态续轮能力', async () => {
    const fixture = await createFixture(`setTimeout(() => {}, 2_000)`)
    const states: BackgroundTaskState[] = []
    const manager = new CommandSessionManager(fixture.storage, {
      onBackgroundTasksChanged: (state) => states.push(state),
    })
    let reopened: CommandSessionManager | null = null
    try {
      const ordinary = await manager.start({
        sessionId: SESSION_A,
        command: fixture.command,
        cwd: fixture.cwd,
      })
      const ordinaryRunning = await manager.backgroundTasks(SESSION_A)
      assert.equal(ordinaryRunning.tasks.length, 1)
      assert.equal(ordinaryRunning.tasks[0]?.id, ordinary.id)
      assert.equal(ordinaryRunning.tasks[0]?.status, 'running')
      assert.equal(ordinaryRunning.tasks[0]?.wakeOnCompletion, false)
      await manager.stop(SESSION_A, ordinary.id)
      const ordinaryStopped = await manager.backgroundTasks(SESSION_A)
      assert.equal(ordinaryStopped.tasks[0]?.status, 'stopped')
      assert.equal(ordinaryStopped.tasks[0]?.wakeOnCompletion, false)

      const notifying = await manager.start({
        sessionId: SESSION_A,
        command: fixture.command,
        cwd: fixture.cwd,
      })
      const beforeHandoff = await manager.backgroundTasks(SESSION_A)
      assert.equal(beforeHandoff.tasks.find((task) => task.id === notifying.id)?.wakeOnCompletion, false)
      const handoff = await manager.armTerminalNotification(SESSION_A, notifying.id)
      assert.equal(handoff.armed, true)
      const running = await manager.backgroundTasks(SESSION_A)
      const notifyingRunning = running.tasks.find((task) => task.id === notifying.id)
      assert.equal(running.tasks.length, 2)
      assert.equal(notifyingRunning?.kind, 'command')
      assert.equal(notifyingRunning?.status, 'running')
      assert.equal(notifyingRunning?.wakeOnCompletion, true)

      await manager.stop(SESSION_A, notifying.id)
      const stopped = await manager.backgroundTasks(SESSION_A)
      const notifyingStopped = stopped.tasks.find((task) => task.id === notifying.id)
      assert.equal(notifyingStopped?.status, 'stopped')
      assert.equal(notifyingStopped?.wakeOnCompletion, false)
      assert.ok(states.length >= 5)
      assert.ok(states.at(-1)!.revision > states[0]!.revision)

      await manager.shutdown()
      reopened = new CommandSessionManager(fixture.storage)
      const restored = await reopened.backgroundTasks(SESSION_A)
      assert.equal(restored.tasks.length, 2)
      assert.equal(restored.tasks.find((task) => task.id === ordinary.id)?.status, 'stopped')
      assert.equal(restored.tasks.find((task) => task.id === notifying.id)?.status, 'stopped')
    } finally {
      await reopened?.shutdown()
      await manager.shutdown()
      await rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

  it('运行任务按最早启动置顶，终态按最新结束下沉', async () => {
    const fixture = await createFixture(`setTimeout(() => {}, 400)`)
    const manager = new CommandSessionManager(fixture.storage)
    try {
      const first = await manager.start({
        sessionId: SESSION_A,
        command: fixture.command,
        cwd: fixture.cwd,
      })
      await manager.armTerminalNotification(SESSION_A, first.id)
      await new Promise((done) => setTimeout(done, 30))
      const second = await manager.start({
        sessionId: SESSION_A,
        command: fixture.command,
        cwd: fixture.cwd,
      })
      await manager.armTerminalNotification(SESSION_A, second.id)
      assert.deepEqual(
        (await manager.backgroundTasks(SESSION_A)).tasks.map((task) => task.id),
        [first.id, second.id],
      )

      await Promise.all([
        waitForTerminal(manager, first.id),
        waitForTerminal(manager, second.id),
      ])
      assert.deepEqual(
        (await manager.backgroundTasks(SESSION_A)).tasks.map((task) => task.id),
        [second.id, first.id],
      )
    } finally {
      await manager.shutdown()
      await rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
})
