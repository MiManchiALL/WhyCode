import { useEffect, useState } from 'react'

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${seconds}s`
}

export function formatProcessingTime(durationMs: number): string {
  return `已处理 ${formatDuration(durationMs)}`
}

export function formatTotalProcessingTime(durationMs: number): string {
  return `总计 ${formatDuration(durationMs)}`
}

export function formatFinishedWorkTime(
  durationMs: number,
  outcome: 'completed' | 'stopped',
): string {
  const duration = formatDuration(durationMs)
  return outcome === 'stopped' ? `你在 ${duration} 后停止了` : `已处理 ${duration}`
}

export function ProcessingTime({ startedAt }: { startedAt: number }) {
  const now = useLiveNow(startedAt)
  return formatProcessingTime(now - startedAt)
}

export function TotalProcessingTime({
  completedDurationMs,
  activeStartedAt,
}: {
  completedDurationMs: number
  activeStartedAt: number | null
}) {
  const now = useLiveNow(activeStartedAt)
  const activeDurationMs = activeStartedAt === null ? 0 : Math.max(0, now - activeStartedAt)
  return formatTotalProcessingTime(completedDurationMs + activeDurationMs)
}

function useLiveNow(startedAt: number | null): number {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (startedAt === null) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [startedAt])

  return now
}
