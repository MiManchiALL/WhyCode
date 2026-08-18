import type { BackgroundTaskSummary } from '@whycode/core'

const STATUS_LABELS: Record<BackgroundTaskSummary['status'], string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
  interrupted: '已中断',
}

export function backgroundTaskStatusLabel(status: BackgroundTaskSummary['status']): string {
  return STATUS_LABELS[status]
}

export function formatBackgroundTaskDuration(
  task: Pick<BackgroundTaskSummary, 'startedAt' | 'endedAt'>,
  now = Date.now(),
): string {
  const start = Date.parse(task.startedAt)
  const end = task.endedAt ? Date.parse(task.endedAt) : now
  const seconds = Math.max(0, Math.floor((end - start) / 1_000))
  if (seconds < 60) return `${seconds}秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}分${seconds % 60}秒`
  const hours = Math.floor(minutes / 60)
  return `${hours}小时${minutes % 60}分`
}
