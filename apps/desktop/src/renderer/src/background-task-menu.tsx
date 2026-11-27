import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { isCommandTaskActive, type BackgroundTaskSummary } from '@whycode/core/background-command'
import { BellRing, ChevronDown, LoaderCircle, Square, Terminal } from 'lucide-react'
import type { ConversationPresentationCache } from './conversation-presentation.ts'
import {
  backgroundTaskStatusLabel,
  formatBackgroundTaskDuration,
} from './background-task-presentation.ts'

type StopAction = {
  taskId: string
  phase: 'armed' | 'pending' | 'failed'
  error?: string
}

export function BackgroundTaskMenu({ sessionId, tasks, presentationCache, onStop, onEmpty }: {
  sessionId: string
  tasks: readonly BackgroundTaskSummary[]
  presentationCache: ConversationPresentationCache
  onStop: (task: BackgroundTaskSummary) => Promise<void>
  onEmpty: () => void
}) {
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(Date.now)
  const [action, setAction] = useState<StopAction | null>(null)
  const [clearedIds, setClearedIds] = useState(() => presentationCache.get(sessionId)?.clearedBackgroundTaskIds)
  const panel = useRef<HTMLDivElement>(null)
  const visibleTasks = clearedIds
    ? tasks.filter(task => isCommandTaskActive(task.status) || !clearedIds.has(task.id))
    : tasks
  const runningCount = visibleTasks.filter(task => isCommandTaskActive(task.status)).length

  useEffect(() => {
    if (visibleTasks.length === 0 && open) setOpen(false)
  }, [open, visibleTasks.length])

  useEffect(() => {
    if (action && (!open || !tasks.some((task) => task.id === action.taskId && isCommandTaskActive(task.status)))) {
      setAction(null)
    }
  }, [open, action, tasks])

  useEffect(() => {
    if (!action || action.phase === 'pending') return
    const timer = window.setTimeout(() => {
      setAction((current) => current === action ? null : current)
    }, action.phase === 'armed' ? 3_000 : 4_000)
    return () => window.clearTimeout(timer)
  }, [action])

  useEffect(() => {
    if (!open || runningCount === 0) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [open, runningCount])

  async function stop(task: BackgroundTaskSummary) {
    if (task.status !== 'running' || (action?.taskId === task.id && action.phase === 'pending')) return
    if (action?.taskId !== task.id || action.phase !== 'armed') {
      setAction({ taskId: task.id, phase: 'armed' })
      return
    }
    const pending: StopAction = { taskId: task.id, phase: 'pending' }
    setAction(pending)
    try {
      await onStop(task)
      // 成功后的终态由 Main 推送；RPC 返回不抢先改写任务状态。
    } catch (error) {
      setAction((current) => current === pending ? {
        taskId: task.id, phase: 'failed', error: error instanceof Error ? error.message : String(error),
      } : current)
    }
  }

  function clearFinished() {
    // 从完整快照取 ID，重复清空时保留仍在快照里的旧项，同时释放已被宿主淘汰的 ID。
    const ids = new Set(tasks.filter(task => !isCommandTaskActive(task.status)).map(task => task.id))
    presentationCache.setClearedBackgroundTaskIds(sessionId, ids)
    setClearedIds(ids)
    if (runningCount > 0) panel.current?.focus()
    else onEmpty()
  }

  if (visibleTasks.length === 0) return null
  const label = runningCount > 0
    ? `${runningCount} 个后台任务运行中`
    : `${visibleTasks.length} 个后台任务`

  return (
    <Dialog.Root open={open} modal={false} onOpenChange={setOpen}>
      <div className="wc-background-tasks" data-open={open ? 'true' : 'false'}>
        <Dialog.Trigger asChild><button
          type="button"
          className="wc-background-tasks-trigger wc-focus-ring"
          aria-label={label}
        >
          <span
            className="wc-background-task-dot"
            data-status={runningCount > 0 ? 'running' : 'settled'}
            aria-hidden="true"
          />
          <span>{label}</span>
          <ChevronDown size={13} className="wc-background-tasks-chevron" aria-hidden="true" />
        </button></Dialog.Trigger>
        <Dialog.Content
          ref={panel}
          className="wc-background-tasks-panel"
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => { if (event.isComposing) event.preventDefault() }}
        >
          <Dialog.Title className="sr-only">后台任务</Dialog.Title>
          <ul className="wc-background-task-list">
            {visibleTasks.map((task) => {
              const current = action?.taskId === task.id ? action : null
              const detail = current?.error ?? task.detail
              const stopLabel = current?.phase === 'armed' ? '确认停止'
                : current?.phase === 'pending' ? '正在停止'
                : current?.phase === 'failed' ? '重试' : '停止'
              return (
                <li key={task.id} className="wc-background-task-row">
                  <span
                    className="wc-background-task-dot"
                    data-status={task.status}
                    aria-hidden="true"
                  />
                  <Terminal size={13} className="wc-background-task-kind-icon" aria-hidden="true" />
                  <span className="wc-background-task-kind">命令</span>
                  <span className="wc-background-task-label" title={task.label}>{task.label}</span>
                  <span
                    className="wc-background-task-wake-slot"
                    title={task.wakeOnCompletion ? '完成后自动续轮' : undefined}
                  >
                    {task.wakeOnCompletion && (
                      <BellRing
                        size={12}
                        className="wc-background-task-wake"
                        aria-label="完成后自动续轮"
                      />
                    )}
                  </span>
                  <span className="wc-background-task-status">
                    {backgroundTaskStatusLabel(task.status)}
                  </span>
                  <time className="wc-background-task-duration">
                    {formatBackgroundTaskDuration(task, now)}
                  </time>
                  <span className="wc-background-task-action">
                    {task.status === 'running' && <button
                      type="button"
                      className="wc-background-task-stop wc-focus-ring"
                      data-armed={current?.phase === 'armed' ? 'true' : undefined}
                      disabled={current?.phase === 'pending'}
                      aria-label={`${stopLabel}后台任务 ${task.label}`}
                      title={current?.phase === 'armed' ? '再次点击停止此任务；3 秒后取消确认' : '停止此任务并通知模型'}
                      onClick={() => { void stop(task) }}
                    >
                      {current?.phase === 'pending' ? <LoaderCircle size={12} className="animate-spin" aria-hidden="true" />
                        : current?.phase !== 'armed' && <Square size={10} aria-hidden="true" />}
                      {stopLabel}
                    </button>}
                  </span>
                  {detail && (
                    <span
                      className="wc-background-task-detail"
                      role={current?.error ? 'alert' : undefined}
                      data-status={current?.error ? 'failed' : task.status}
                      title={detail}
                    >
                      {detail}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
          {visibleTasks.length > runningCount && (
            <div className="flex shrink-0 justify-end border-t border-[var(--wc-line)] px-2 py-1">
              <button
                type="button"
                className="wc-focus-ring rounded-md px-2 py-1 text-xs text-[var(--wc-muted)] hover:bg-black/[0.05] hover:text-[var(--wc-ink)]"
                title="从列表中移除已结束的任务，保留命令输出"
                onClick={clearFinished}
              >
                清空已结束任务
              </button>
            </div>
          )}
        </Dialog.Content>
      </div>
    </Dialog.Root>
  )
}
