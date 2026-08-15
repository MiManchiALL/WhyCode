import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  createBackgroundCommandTools,
  START_COMMAND_TOOL_NAME,
  STOP_COMMAND_TOOL_NAME,
  WRITE_COMMAND_INPUT_TOOL_NAME,
} from './index.ts'
import { CommandSessionManager } from './manager.ts'
import type {
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

  it('等待中的有限命令随当前 turn 取消并终止进程树', async () => {
    const fixture = await createFixture(
      `process.stdout.write('ready\\n'); setInterval(() => {}, 1000)`,
    )
    const manager = new CommandSessionManager(fixture.storage)
    try {
      const started = await manager.start({
        sessionId: SESSION_A,
        command: fixture.command,
        cwd: fixture.cwd,
      })
      const controller = new AbortController()
      await assert.rejects(
        manager.waitForTerminal(SESSION_A, started.id, controller.signal, () => {
          controller.abort()
        }),
        /操作已取消/,
      )
      assert.equal((await manager.list(SESSION_A))[0]?.status, 'stopped')
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
    const writeInput = tools.find((tool) => tool.name === WRITE_COMMAND_INPUT_TOOL_NAME)
    const stop = tools.find((tool) => tool.name === STOP_COMMAND_TOOL_NAME)
    assert.ok(start)
    assert.ok(writeInput)
    assert.ok(stop)
    assert.equal(start.kind, 'execute')
    assert.equal(writeInput.kind, 'execute')
    assert.equal(stop.kind, 'control')
    assert.equal(start.checkpointScope, undefined)
  })

  it('有限命令等待终态并回传进度，只有显式 detach 的持久进程立即返回', async () => {
    const finite = await createFixture(
      `process.stdout.write('installing\\n'); setTimeout(() => process.stdout.write('ready\\n'), 50)`,
    )
    const manager = new CommandSessionManager(finite.storage)
    try {
      const start = createBackgroundCommandTools(manager, SESSION_A)
        .find((tool) => tool.name === START_COMMAND_TOOL_NAME)
      assert.ok(start)
      let progress = ''
      const result = await start.execute({
        command: finite.command,
        cwd: finite.cwd,
      }, {
        projectDir: finite.cwd,
        additionalDirs: [],
        abortSignal: new AbortController().signal,
        onProgress: (output) => { progress += output },
      })
      assert.equal(result.isError, false)
      assert.match(result.data, /状态：completed/)
      assert.match(result.data, /ready/)
      assert.match(progress, /installing/)
      assert.match(progress, /ready/)

      const persistentFixture = await createFixture(
        `process.stdout.write('server ready\\n'); setInterval(() => {}, 1000)`,
      )
      try {
        const detached = await start.execute({
          command: persistentFixture.command,
          cwd: persistentFixture.cwd,
          detach: true,
        }, {
          projectDir: persistentFixture.cwd,
          additionalDirs: [],
          abortSignal: new AbortController().signal,
        })
        assert.match(detached.data, /状态：running/)
        const running = (await manager.list(SESSION_A)).find((item) => item.status === 'running')
        assert.ok(running)
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

  it('显式脱离任务自然结束后只通知一次，用户停止不产生续轮通知', async () => {
    const fixture = await createFixture(
      `process.stdout.write('started\\n'); setTimeout(() => process.stdout.write('done\\n'), 100)`,
    )
    const notifications: CommandTaskTerminalNotification[] = []
    const manager = new CommandSessionManager(fixture.storage, {
      onDetachedTaskTerminal: (notification) => notifications.push(notification),
    })
    try {
      const start = createBackgroundCommandTools(manager, SESSION_A)
        .find((tool) => tool.name === START_COMMAND_TOOL_NAME)
      assert.ok(start)
      const detached = await start.execute({
        command: fixture.command,
        cwd: fixture.cwd,
        detach: true,
      }, {
        projectDir: fixture.cwd,
        additionalDirs: [],
        abortSignal: new AbortController().signal,
        engagedPlanId: '33333333-3333-4333-8333-333333333333',
      })
      assert.match(detached.data, /自动通知并唤醒所属 Main/)
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
        const stoppedStart = await start.execute({
          command: persistent.command,
          cwd: persistent.cwd,
          detach: true,
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
})
