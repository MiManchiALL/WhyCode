import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { terminateProcessTree } from '../run-command/process-termination.ts'
import {
  type CommandOutputChunk,
  type CommandTaskSnapshot,
  type CommandTaskStatus,
  type PersistedCommandTask,
} from './types.ts'
import { CommandTaskStorage } from './storage.ts'

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_RUNNING_COMMANDS = 16
const MAX_RETAINED_TERMINAL_TASKS = 16
const DEFAULT_READ_BYTES = 32 * 1024
const PROCESS_CLOSE_GRACE_MS = 2_000

interface LiveCommandTask extends PersistedCommandTask {
  child?: ChildProcessWithoutNullStreams
  timeout?: ReturnType<typeof setTimeout>
  stopReason?: 'user' | 'timeout' | 'shutdown'
  outputWriteFailed?: boolean
  terminalPersisted?: boolean
  writeTail: Promise<void>
  persistTail: Promise<void>
  finishPromise?: Promise<void>
  stopPromise?: Promise<void>
  waiters: Set<() => void>
}

export interface StartCommandInput {
  sessionId: string
  command: string
  cwd: string
  timeoutMs?: number
}

/**
 * 宿主级后台命令管理器。任务按会话隔离，但管理器跨 AgentSession 存活，
 * 因而切换对话不会丢进程；重启只恢复日志与终态，不尝试附着到未知旧进程。
 */
export class CommandSessionManager {
  private readonly tasks = new Map<string, LiveCommandTask>()
  private readonly storage: CommandTaskStorage
  private initialized = false
  private initialization: Promise<void> | null = null

  constructor(storageRoot: string) {
    this.storage = new CommandTaskStorage(storageRoot)
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    this.initialization ??= this.loadPersistedTasks()
    try {
      await this.initialization
      this.initialized = true
    } catch (error) {
      this.initialization = null
      throw error
    }
  }

  private async loadPersistedTasks(): Promise<void> {
    await this.storage.initialize()
    const sessionIds = new Set<string>()
    for (const persisted of await this.storage.loadAll()) {
      const task = this.hydrate(persisted)
      this.tasks.set(this.key(task.sessionId, task.id), task)
      sessionIds.add(task.sessionId)
      if (task.status === 'running') {
        task.status = 'interrupted'
        task.endedAt = new Date().toISOString()
        task.failureReason = '上次应用异常退出，原进程无法安全重连'
        await this.persist(task)
        task.terminalPersisted = true
      }
    }
    for (const sessionId of sessionIds) await this.pruneTerminalTasks(sessionId)
  }

  async start(input: StartCommandInput): Promise<CommandTaskSnapshot> {
    await this.initialize()
    if (this.runningTasks().length >= MAX_RUNNING_COMMANDS) {
      throw new Error(`后台命令已达到全局上限 ${MAX_RUNNING_COMMANDS}，请先停止不再需要的任务`)
    }
    await this.pruneTerminalTasks(input.sessionId)

    const id = crypto.randomUUID()
    const cwd = resolve(input.cwd)
    const task: LiveCommandTask = {
      schemaVersion: 1,
      id,
      sessionId: input.sessionId,
      command: input.command,
      cwd,
      status: 'running',
      startedAt: new Date().toISOString(),
      outputBytes: 0,
      outputTruncated: false,
      writeTail: Promise.resolve(),
      persistTail: Promise.resolve(),
      waiters: new Set(),
    }
    await this.storage.prepare(task)
    this.tasks.set(this.key(input.sessionId, id), task)

    const child = spawn(input.command, {
      shell: process.platform === 'win32' ? 'powershell.exe' : true,
      cwd,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        NO_COLOR: '1',
        PAGER: 'cat',
        GIT_PAGER: 'cat',
      },
    })
    task.child = child
    child.stdout.on('data', (chunk: Buffer) => this.appendOutput(task, chunk))
    child.stderr.on('data', (chunk: Buffer) => this.appendOutput(task, chunk))
    child.on('close', (code) => {
      this.runDetached(task, this.trackFinish(task, () => this.finishFromClose(task, code)))
    })

    const launchError = await new Promise<Error | null>((done) => {
      child.once('spawn', () => done(null))
      child.once('error', (error) => done(error))
    })
    if (launchError) {
      await this.trackFinish(task, () =>
        this.finish(task, 'failed', null, `启动失败：${launchError.message}`),
      )
      return this.snapshot(task)
    }
    child.on('error', (error) => {
      this.runDetached(
        task,
        this.trackFinish(task, () =>
          this.finish(task, 'failed', child.exitCode, `进程错误：${error.message}`),
        ),
      )
    })
    try {
      await this.persist(task)
    } catch (error) {
      // 没有可靠 manifest 就不能把进程交给后台；先清理进程树，避免生成无法管理的孤儿。
      await this.stopTask(task, 'shutdown').catch(() => undefined)
      this.tasks.delete(this.key(task.sessionId, task.id))
      await this.storage.removeTask(task).catch(() => undefined)
      throw error
    }

    if (input.timeoutMs && task.status === 'running') {
      task.timeout = setTimeout(
        () => this.runDetached(task, this.stopTask(task, 'timeout')),
        input.timeoutMs,
      )
      task.timeout.unref()
    }
    return this.snapshot(task)
  }

  async readOutput(
    sessionId: string,
    taskId: string,
    offset = 0,
    maxBytes = DEFAULT_READ_BYTES,
    waitMs = 0,
  ): Promise<CommandOutputChunk> {
    const task = await this.getOwnedTask(sessionId, taskId)
    if (waitMs > 0 && task.status === 'running' && offset >= task.outputBytes) {
      await this.waitForChange(task, waitMs)
    }
    await task.writeTail
    const chunk = await this.storage.readOutput(task, offset, maxBytes)
    return {
      task: this.snapshot(task),
      ...chunk,
    }
  }

  async writeInput(
    sessionId: string,
    taskId: string,
    input: string,
    closeAfterWrite = false,
  ): Promise<CommandTaskSnapshot> {
    const task = await this.getOwnedTask(sessionId, taskId)
    if (task.status !== 'running' || !task.child?.stdin.writable) {
      throw new Error(`后台命令 ${taskId} 已不接受输入（状态：${task.status}）`)
    }
    await new Promise<void>((done, reject) => {
      const callback = (error?: Error | null) => (error ? reject(error) : done())
      if (closeAfterWrite) task.child!.stdin.end(input, callback)
      else task.child!.stdin.write(input, callback)
    })
    return this.snapshot(task)
  }

  async stop(sessionId: string, taskId: string): Promise<CommandTaskSnapshot> {
    const task = await this.getOwnedTask(sessionId, taskId)
    await this.stopTask(task, 'user')
    return this.snapshot(task)
  }

  async list(sessionId: string): Promise<CommandTaskSnapshot[]> {
    await this.initialize()
    return [...this.tasks.values()]
      .filter((task) => task.sessionId === sessionId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((task) => this.snapshot(task))
  }

  async stopSession(sessionId: string): Promise<void> {
    await this.initialize()
    const owned = [...this.tasks.values()].filter((task) => task.sessionId === sessionId)
    await Promise.all(
      owned
        .filter((task) => task.status === 'running')
        .map((task) => this.stopTask(task, 'shutdown')),
    )
    await Promise.all(owned.map((task) => this.settleTask(task)))
  }

  async removeSession(sessionId: string): Promise<void> {
    await this.stopSession(sessionId)
    for (const task of [...this.tasks.values()]) {
      if (task.sessionId === sessionId) this.tasks.delete(this.key(sessionId, task.id))
    }
    await this.storage.removeSession(sessionId)
  }

  async shutdown(): Promise<void> {
    await this.initialize()
    const tasks = [...this.tasks.values()]
    await Promise.all(
      tasks
        .filter((task) => task.status === 'running')
        .map((task) => this.stopTask(task, 'shutdown')),
    )
    await Promise.all(tasks.map((task) => this.settleTask(task)))
  }

  private runningTasks(): LiveCommandTask[] {
    return [...this.tasks.values()].filter((task) => task.status === 'running')
  }

  private async getOwnedTask(sessionId: string, taskId: string): Promise<LiveCommandTask> {
    await this.initialize()
    const task = this.tasks.get(this.key(sessionId, taskId))
    if (!task) throw new Error(`当前会话不存在后台命令：${taskId}`)
    return task
  }

  private appendOutput(task: LiveCommandTask, chunk: Buffer): void {
    if (task.status !== 'running' || chunk.length === 0) return
    const remaining = MAX_OUTPUT_BYTES - task.outputBytes
    if (remaining <= 0) {
      task.outputTruncated = true
      return
    }
    const accepted = chunk.subarray(0, remaining)
    task.outputBytes += accepted.length
    if (accepted.length < chunk.length) task.outputTruncated = true
    task.writeTail = task.writeTail
      .then(() => this.storage.appendOutput(task, accepted))
      .catch(() => {
        task.outputTruncated = true
        task.outputWriteFailed = true
      })
    this.notify(task)
  }

  private async finishFromClose(task: LiveCommandTask, code: number | null): Promise<void> {
    if (task.stopReason === 'timeout') {
      await this.finish(task, 'failed', code, '后台命令超时，已请求终止进程树')
    } else if (task.stopReason) {
      const reason = task.stopReason === 'shutdown' ? '应用退出时已终止' : '用户已停止'
      await this.finish(task, 'stopped', code, reason)
    } else {
      await this.finish(task, code === 0 ? 'completed' : 'failed', code, code === 0 ? undefined : `退出码 ${code}`)
    }
  }

  private stopTask(
    task: LiveCommandTask,
    reason: 'user' | 'timeout' | 'shutdown',
  ): Promise<void> {
    if (task.status !== 'running') return Promise.resolve()
    task.stopPromise ??= this.performStop(task, reason)
    return task.stopPromise
  }

  private async performStop(
    task: LiveCommandTask,
    reason: 'user' | 'timeout' | 'shutdown',
  ): Promise<void> {
    task.stopReason = reason
    const child = task.child
    const confirmed = child ? await terminateProcessTree(child).catch(() => false) : false
    if (child && child.exitCode === null && child.signalCode === null) {
      await Promise.race([
        once(child, 'close').then(() => undefined, () => undefined),
        new Promise<void>((done) => setTimeout(done, PROCESS_CLOSE_GRACE_MS)),
      ])
    }
    if (task.status !== 'running') {
      await task.finishPromise
      return
    }
    const status: CommandTaskStatus = reason === 'timeout' ? 'failed' : 'stopped'
    const label = reason === 'timeout' ? '后台命令超时' : reason === 'shutdown' ? '应用退出时已终止' : '用户已停止'
    await this.trackFinish(task, () =>
      this.finish(
        task,
        status,
        task.child?.exitCode ?? null,
        confirmed ? label : `${label}；未能确认全部子进程均已终止`,
      ),
    )
  }

  private async finish(
    task: LiveCommandTask,
    status: CommandTaskStatus,
    exitCode: number | null,
    failureReason?: string,
  ): Promise<void> {
    if (task.status !== 'running') return
    task.status = status
    task.exitCode = exitCode
    task.endedAt = new Date().toISOString()
    task.failureReason = [failureReason, task.outputWriteFailed ? '输出日志写入不完整' : undefined]
      .filter(Boolean)
      .join('；') || undefined
    if (task.timeout) clearTimeout(task.timeout)
    task.child = undefined
    await task.writeTail
    await this.persist(task)
    task.terminalPersisted = true
    await this.pruneTerminalTasks(task.sessionId)
    this.notify(task)
  }

  private waitForChange(task: LiveCommandTask, waitMs: number): Promise<void> {
    return new Promise((done) => {
      const complete = () => {
        clearTimeout(timeout)
        task.waiters.delete(complete)
        done()
      }
      const timeout = setTimeout(complete, waitMs)
      task.waiters.add(complete)
    })
  }

  private notify(task: LiveCommandTask): void {
    for (const waiter of [...task.waiters]) waiter()
  }

  private runDetached(task: LiveCommandTask, operation: Promise<void>): void {
    void operation.catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      task.failureReason = `${task.failureReason ? `${task.failureReason}；` : ''}后台任务状态保存失败：${message}`
      this.notify(task)
    })
  }

  private trackFinish(task: LiveCommandTask, operation: () => Promise<void>): Promise<void> {
    task.finishPromise ??= operation()
    return task.finishPromise
  }

  private async settleTask(task: LiveCommandTask): Promise<void> {
    await task.finishPromise
    await task.writeTail
    await task.persistTail
  }

  private snapshot(task: LiveCommandTask): CommandTaskSnapshot {
    return {
      schemaVersion: 1,
      id: task.id,
      sessionId: task.sessionId,
      command: task.command,
      cwd: task.cwd,
      status: task.status,
      startedAt: task.startedAt,
      ...(task.endedAt ? { endedAt: task.endedAt } : {}),
      ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
      ...(task.failureReason ? { failureReason: task.failureReason } : {}),
      outputBytes: task.outputBytes,
      outputTruncated: task.outputTruncated,
      canWrite: task.status === 'running' && Boolean(task.child?.stdin.writable),
    }
  }

  private hydrate(persisted: PersistedCommandTask): LiveCommandTask {
    return {
      ...persisted,
      terminalPersisted: persisted.status !== 'running',
      writeTail: Promise.resolve(),
      persistTail: Promise.resolve(),
      waiters: new Set(),
    }
  }

  private async persist(task: LiveCommandTask): Promise<void> {
    const snapshot = this.snapshot(task)
    const write = task.persistTail.then(() => this.storage.persist(snapshot))
    task.persistTail = write.catch(() => undefined)
    await write
  }

  private async pruneTerminalTasks(sessionId: string): Promise<void> {
    const terminal = [...this.tasks.values()]
      .filter((task) => task.sessionId === sessionId && task.terminalPersisted)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    for (const task of terminal.slice(MAX_RETAINED_TERMINAL_TASKS)) {
      this.tasks.delete(this.key(sessionId, task.id))
      await this.storage.removeTask(task)
    }
  }

  private key(sessionId: string, taskId: string): string {
    return `${sessionId}:${taskId}`
  }
}
