import { useEffect, useRef, useState } from 'react'
import type { BackgroundTaskSummary } from '@whycode/core'
import { BellRing, ChevronDown, Terminal } from 'lucide-react'
import {
  backgroundTaskStatusLabel,
  formatBackgroundTaskDuration,
} from './background-task-presentation.ts'

export function BackgroundTaskMenu({ tasks }: { tasks: readonly BackgroundTaskSummary[] }) {
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(Date.now)
  const rootRef = useRef<HTMLDivElement>(null)
  const runningCount = tasks.filter((task) => task.status === 'running').length

  useEffect(() => {
    if (tasks.length === 0 && open) setOpen(false)
  }, [open, tasks.length])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return
      setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  useEffect(() => {
    if (!open || runningCount === 0) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [open, runningCount])

  if (tasks.length === 0) return null
  const label = runningCount > 0
    ? `${runningCount} 个后台任务运行中`
    : `${tasks.length} 个后台任务`

  return (
    <div ref={rootRef} className="wc-background-tasks" data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        className="wc-background-tasks-trigger wc-focus-ring"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((current) => !current)}
      >
        <span
          className="wc-background-task-dot"
          data-status={runningCount > 0 ? 'running' : 'settled'}
          aria-hidden="true"
        />
        <span>{label}</span>
        <ChevronDown size={13} className="wc-background-tasks-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div className="wc-background-tasks-panel" role="dialog" aria-label="后台任务">
          <ul className="wc-background-task-list">
            {tasks.map((task) => (
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
                {task.detail && (
                  <span className="wc-background-task-detail" title={task.detail}>
                    {task.detail}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
