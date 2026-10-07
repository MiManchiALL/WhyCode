import { localWorkspaceIO, type WorkspaceIO } from '../../workspace/io.ts'
import { stopWorkspaceProcess, type WorkspaceProcess } from '../../workspace/process.ts'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { unicodeSafePrefix } from '../../text.ts'
import {
  isCommandTaskActive,
  type BackgroundTaskState,
  type BackgroundTaskSummary,
  type CommandOutputChunk,
  type CommandTaskNotificationHandoff,
  type CommandTaskSnapshot,
  type CommandTaskStatus,
  type CommandTaskTerminalNotification,
  type PersistedCommandTask,
} from './types.ts'
import { CommandTaskStorage } from './storage.ts'
import { powerShellCommandArgs } from '../powershell.ts'

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_RUNNING_COMMANDS = 16
const MAX_RETAINED_TERMINAL_TASKS = 16
const DEFAULT_READ_BYTES = 32 * 1024
const PROCESS_CLOSE_GRACE_MS = 2_000
const MAX_BACKGROUND_TASK_LABEL_CHARS = 500
const MAX_BACKGROUND_TASK_DETAIL_CHARS = 240

type CommandStopRequest = { source: 'model'; detail?: string } | { source: 'user' }
type CommandStopReason = CommandStopRequest | { source: 'timeout' | 'shutdown' }
const COMMAND_STOP_DETAILS: Record<CommandStopReason['source'], string> = {
  model: '模型主动停止',
  user: '用户主动停止',
  timeout: '后台命令超时，已请求终止进程树',
  shutdown: '应用退出时已终止',
}

interface OutputReader {
  wake?: () => void
}

interface LiveCommandTask extends PersistedCommandTask {
  child?: ChildProcessWithoutNullStreams | WorkspaceProcess
  timeout?: ReturnType<typeof setTimeout>
  stopReason?: CommandStopReason
  outputWriteFailed?: boolean
  terminalPersisted?: boolean
  writeTail: Promise<void>
  persistTail: Promise<void>
  finishPromise?: Promise<void>
  stopPromise?: Promise<void>
  readers: Set<OutputReader>
  terminalNotification?: { engagedPlanId?: string }
  terminalNotificationSent?: boolean
}

export interface CommandStartInput {
  workspaceIO?: WorkspaceIO
  sessionId: string
  command: string
  cwd: string
  timeoutMs?: number
}

export interface CommandSessionManagerOptions {
  onBackgroundTaskTerminal?: (notification: CommandTaskTerminalNotification) => void
  onBackgroundTasksChanged?: (state: BackgroundTaskState) => void
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
  private readonly onBackgroundTaskTerminal?: CommandSessionManagerOptions['onBackgroundTaskTerminal']
  private readonly onBackgroundTasksChanged?: CommandSessionManagerOptions['onBackgroundTasksChanged']
  private backgroundTaskRevision = 0

  constructor(storageRoot: string, options: CommandSessionManagerOptions = {}) {
    this.storage = new CommandTaskStorage(storageRoot)
    this.onBackgroundTaskTerminal = options.onBackgroundTaskTerminal
    this.onBackgroundTasksChanged = options.onBackgroundTasksChanged
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
      if (isCommandTaskActive(task.status)) {
        task.status = 'interrupted'
        task.endedAt = new Date().toISOString()
        task.failureReason = '上次应用异常退出，原进程无法安全重连'
        await this.persist(task)
        task.terminalPersisted = true
      }
    }
    for (const sessionId of sessionIds) await this.pruneTerminalTasks(sessionId)
  }

  async start(input: CommandStartInput): Promise<CommandTaskSnapshot> {
    await this.initialize()
    if (this.runningTasks().length >= MAX_RUNNING_COMMANDS) {
      throw new Error(`后台命令已达到全局上限 ${MAX_RUNNING_COMMANDS}，请先停止不再需要的任务`)
    }
    if (await this.pruneTerminalTasks(input.sessionId)) {
      this.publishBackgroundTasks(input.sessionId)
    }

    const id = crypto.randomUUID()
    const io = input.workspaceIO ?? localWorkspaceIO
    const cwd = io.path.resolve(input.cwd)
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
      readers: new Set(),
    }
    await this.storage.prepare(task)
    this.tasks.set(this.key(input.sessionId, id), task)

    let child: ChildProcessWithoutNullStreams | WorkspaceProcess
    try {
      child = io.spawn ? io.spawn(input.command, cwd) : spawn(
        process.platform === 'win32' ? 'powershell.exe' : input.command,
        process.platform === 'win32' ? powerShellCommandArgs(input.command) : [],
        {
          shell: process.platform !== 'win32',
          cwd,
          windowsHide: true,
          detached: process.platform !== 'win32',
          env: {
            ...process.env,
            NO_COLOR: '1',
            PAGER: 'cat',
            GIT_PAGER: 'cat',
          },
        },
      )
    } catch (error) {
      await this.finish(task, 'failed', null, `启动失败：${error instanceof Error ? error.message : String(error)}`)
      return this.snapshot(task)
    }
    task.child = child
    child.stdout.on('data', (chunk: Buffer) => this.appendOutput(task, chunk))
    child.stderr.on('data', (chunk: Buffer) => this.appendOutput(task, chunk))
    child.on('close', (code) => {
      // 停止请求需同时结算进程树终止结果；close 不能抢先宣布成功或丢掉失败诊断。
      if (task.status === 'stopping') return
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
      await this.stopTask(task, { source: 'shutdown' }).catch(() => undefined)
      this.tasks.delete(this.key(task.sessionId, task.id))
      await this.storage.removeTask(task).catch(() => undefined)
      throw error
    }

    if (task.status === 'running') this.publishBackgroundTasks(task.sessionId)

    if (input.timeoutMs && task.status === 'running') {
      task.timeout = setTimeout(
        () => this.runDetached(task, this.stopTask(task, { source: 'timeout' })),
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
    abortSignal?: AbortSignal,
  ): Promise<CommandOutputChunk> {
    const task = await this.getOwnedTask(sessionId, taskId)
    abortSignal?.throwIfAborted()
    // 读取者一直登记到日志与终态一并返回；只唤醒等待者还不代表结果已交付。
    const reader: OutputReader = {}
    task.readers.add(reader)
    const release = () => {
      reader.wake?.()
      task.readers.delete(reader)
      this.emitTerminalNotification(task)
    }
    abortSignal?.addEventListener('abort', release, { once: true })
    try {
      if (waitMs > 0 && isCommandTaskActive(task.status) && offset >= task.outputBytes) {
        await this.waitForChange(reader, waitMs)
      }
      abortSignal?.throwIfAborted()
      await task.writeTail
      const chunk = await this.storage.readOutput(task, offset, maxBytes)
      abortSignal?.throwIfAborted()
      const snapshot = this.snapshot(task)
      if (!isCommandTaskActive(snapshot.status)) task.terminalNotificationSent = true
      return { task: snapshot, ...chunk }
    } finally {
      abortSignal?.removeEventListener('abort', release)
      release()
    }
  }

  /**
   * RunCommand 即将把仍在运行的进程交给后台任务管理器时才武装通知。若进程已经结束，
   * 调用方仍在当前工具结果中读取终态，避免同一结果同时走工具返回和后台续轮。
   */
  async armTerminalNotification(
    sessionId: string,
    taskId: string,
    engagedPlanId?: string,
  ): Promise<CommandTaskNotificationHandoff> {
    const task = await this.getOwnedTask(sessionId, taskId)
    if (task.status !== 'running') return { task: this.snapshot(task), armed: false }
    task.terminalNotification = engagedPlanId ? { engagedPlanId } : {}
    const snapshot = this.snapshot(task)
    try {
      await this.persist(task)
    } catch (error) {
      task.terminalNotification = undefined
      throw error
    }
    this.publishBackgroundTasks(sessionId)
    return { task: snapshot, armed: true }
  }

  hasPendingPlanContinuation(sessionId: string, planId: string): boolean {
    return [...this.tasks.values()].some((task) =>
      task.sessionId === sessionId
      && (isCommandTaskActive(task.status) || task.status === 'completed' || task.status === 'failed'
        || (task.status === 'stopped' && task.stopReason?.source === 'user'))
      && task.terminalNotification?.engagedPlanId === planId
      && task.terminalNotificationSent !== true,
    )
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

  /** 来源由工具或宿主入口指定，不能从停止说明推断。 */
  async stop(sessionId: string, taskId: string, reason: CommandStopRequest): Promise<CommandTaskSnapshot> {
    const task = await this.getOwnedTask(sessionId, taskId)
    await this.stopTask(task, reason)
    return this.snapshot(task)
  }

  async list(sessionId: string): Promise<CommandTaskSnapshot[]> {
    await this.initialize()
    return [...this.tasks.values()]
      .filter((task) => task.sessionId === sessionId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((task) => this.snapshot(task))
  }

  async backgroundTasks(sessionId: string): Promise<BackgroundTaskState> {
    await this.initialize()
    return this.backgroundTaskState(sessionId)
  }

  async stopSession(sessionId: string): Promise<void> {
    await this.initialize()
    const owned = [...this.tasks.values()].filter((task) => task.sessionId === sessionId)
    await Promise.all(
      owned
        .filter((task) => isCommandTaskActive(task.status))
        .map((task) => this.stopTask(task, { source: 'shutdown' })),
    )
    await Promise.all(owned.map((task) => this.settleTask(task)))
  }

  async removeSession(sessionId: string): Promise<void> {
    await this.stopSession(sessionId)
    const hadTasks = [...this.tasks.values()].some((task) => task.sessionId === sessionId)
    for (const task of [...this.tasks.values()]) {
      if (task.sessionId === sessionId) this.tasks.delete(this.key(sessionId, task.id))
    }
    await this.storage.removeSession(sessionId)
    if (hadTasks) this.publishBackgroundTasks(sessionId)
  }

  async shutdown(): Promise<void> {
    await this.initialize()
    const tasks = [...this.tasks.values()]
    await Promise.all(
      tasks
        .filter((task) => isCommandTaskActive(task.status))
        .map((task) => this.stopTask(task, { source: 'shutdown' })),
    )
    await Promise.all(tasks.map((task) => this.settleTask(task)))
  }

  private runningTasks(): LiveCommandTask[] {
    return [...this.tasks.values()].filter((task) => isCommandTaskActive(task.status))
  }

  private async getOwnedTask(sessionId: string, taskId: string): Promise<LiveCommandTask> {
    await this.initialize()
    const task = this.tasks.get(this.key(sessionId, taskId))
    if (!task) throw new Error(`当前会话不存在后台命令：${taskId}`)
    return task
  }

  private appendOutput(task: LiveCommandTask, chunk: Buffer): void {
    if (!isCommandTaskActive(task.status) || chunk.length === 0) return
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
    task.stopReason = undefined
    await this.finish(task, code === 0 ? 'completed' : 'failed', code, code === 0 ? undefined : `退出码 ${code}`)
  }

  private stopTask(
    task: LiveCommandTask,
    reason: CommandStopReason,
  ): Promise<void> {
    if (task.stopPromise) return task.stopPromise
    if (!isCommandTaskActive(task.status)) return task.finishPromise ?? Promise.resolve()
    task.stopPromise = this.performStop(task, reason).finally(() => { task.stopPromise = undefined })
    return task.stopPromise
  }

  private async performStop(
    task: LiveCommandTask,
    reason: CommandStopReason,
  ): Promise<void> {
    const child = task.child
    // exit 可先于 close 到达，此时保留进程自己的结果并等待剩余输出。
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      await waitForProcessClose(child)
      await this.trackFinish(task, () => this.finishFromClose(task, child.exitCode))
      return
    }
    task.stopReason = reason
    task.status = 'stopping'
    this.publishBackgroundTasks(task.sessionId)
    const confirmed = child ? await stopWorkspaceProcess(child).catch(() => false) : false
    if (child && child.exitCode === null && child.signalCode === null) {
      await waitForProcessClose(child)
    }
    if (!isCommandTaskActive(task.status)) {
      await task.finishPromise
      return
    }
    if (!child || (child.exitCode === null && child.signalCode === null)) {
      task.stopReason = undefined
      task.status = 'running'
      this.publishBackgroundTasks(task.sessionId)
      throw new Error('未能确认后台命令已停止，请重试')
    }
    if (!confirmed && child.exitCode === 0) {
      await this.trackFinish(task, () => this.finishFromClose(task, 0))
      return
    }
    const status: CommandTaskStatus = reason.source === 'timeout' ? 'failed' : 'stopped'
    const label = commandStopDetail(reason)
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
    if (!isCommandTaskActive(task.status)) return
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
    this.publishBackgroundTasks(task.sessionId)
    this.emitTerminalNotification(task)
  }

  private emitTerminalNotification(task: LiveCommandTask): void {
    if (
      task.terminalNotificationSent
      || !task.terminalPersisted
      || task.readers.size > 0
      || (!task.terminalNotification && task.stopReason?.source !== 'user')
      || !this.onBackgroundTaskTerminal
      || (task.status !== 'completed' && task.status !== 'failed' && task.status !== 'stopped')
      || task.stopReason?.source === 'model'
      || task.stopReason?.source === 'shutdown'
    ) return
    task.terminalNotificationSent = true
    this.onBackgroundTaskTerminal({
      task: this.snapshot(task),
      ...(task.terminalNotification?.engagedPlanId
        ? { engagedPlanId: task.terminalNotification.engagedPlanId }
        : {}),
    })
  }

  private waitForChange(
    reader: OutputReader,
    waitMs: number,
  ): Promise<void> {
    return new Promise((done) => {
      const complete = () => {
        clearTimeout(timeout)
        reader.wake = undefined
        done()
      }
      const timeout = setTimeout(complete, waitMs)
      reader.wake = complete
    })
  }

  private notify(task: LiveCommandTask): void {
    for (const reader of task.readers) reader.wake?.()
  }

  private runDetached(task: LiveCommandTask, operation: Promise<void>): void {
    void operation.catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      task.failureReason = `${task.failureReason ? `${task.failureReason}；` : ''}后台任务操作失败：${message}`
      this.notify(task)
      this.publishBackgroundTasks(task.sessionId)
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
      terminalPersisted: !isCommandTaskActive(persisted.status),
      writeTail: Promise.resolve(),
      persistTail: Promise.resolve(),
      readers: new Set(),
    }
  }

  private async persist(task: LiveCommandTask): Promise<void> {
    const snapshot = this.snapshot(task)
    const write = task.persistTail.then(() => this.storage.persist(snapshot))
    task.persistTail = write.catch(() => undefined)
    await write
  }

  private async pruneTerminalTasks(sessionId: string): Promise<boolean> {
    const terminal = [...this.tasks.values()]
      .filter((task) => task.sessionId === sessionId && task.terminalPersisted)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    let removedTask = false
    for (const task of terminal.slice(MAX_RETAINED_TERMINAL_TASKS)) {
      removedTask = true
      this.tasks.delete(this.key(sessionId, task.id))
      await this.storage.removeTask(task)
    }
    return removedTask
  }

  private backgroundTaskState(sessionId: string): BackgroundTaskState {
    const tasks = [...this.tasks.values()]
      .filter((task) => task.sessionId === sessionId)
      .sort(compareBackgroundTasks)
      .map((task): BackgroundTaskSummary => ({
        id: task.id,
        sessionId: task.sessionId,
        kind: 'command',
        label: compactBackgroundTaskText(task.command, MAX_BACKGROUND_TASK_LABEL_CHARS),
        status: task.status,
        startedAt: task.startedAt,
        ...(task.endedAt ? { endedAt: task.endedAt } : {}),
        ...(task.failureReason
          ? { detail: compactBackgroundTaskText(task.failureReason, MAX_BACKGROUND_TASK_DETAIL_CHARS) }
          : {}),
        wakeOnCompletion:
          task.status === 'running'
          && Boolean(task.terminalNotification)
          && task.terminalNotificationSent !== true,
      }))
    return { sessionId, revision: this.backgroundTaskRevision, tasks }
  }

  private publishBackgroundTasks(sessionId: string): void {
    if (!this.onBackgroundTasksChanged) return
    this.backgroundTaskRevision += 1
    this.onBackgroundTasksChanged(this.backgroundTaskState(sessionId))
  }

  private key(sessionId: string, taskId: string): string {
    return `${sessionId}:${taskId}`
  }
}

function commandStopDetail(reason: CommandStopReason): string {
  const label = COMMAND_STOP_DETAILS[reason.source]
  return reason.source === 'model' && reason.detail ? `${label}：${reason.detail}` : label
}

function compareBackgroundTasks(left: LiveCommandTask, right: LiveCommandTask): number {
  const leftRunning = isCommandTaskActive(left.status)
  const rightRunning = isCommandTaskActive(right.status)
  if (leftRunning !== rightRunning) return leftRunning ? -1 : 1
  if (leftRunning) return left.startedAt.localeCompare(right.startedAt)
  return (right.endedAt ?? right.startedAt).localeCompare(left.endedAt ?? left.startedAt)
}

function waitForProcessClose(child: ChildProcessWithoutNullStreams | WorkspaceProcess): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      child.off('close', done)
      child.off('error', done)
      resolve()
    }
    const timer = setTimeout(done, PROCESS_CLOSE_GRACE_MS)
    child.once('close', done)
    child.once('error', done)
  })
}

function compactBackgroundTaskText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return `${unicodeSafePrefix(normalized, maxChars - 1)}…`
}
