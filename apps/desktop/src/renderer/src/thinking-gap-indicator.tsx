import {
  HEART_WAVE_FLOW_SPAN,
  HEART_WAVE_LOOP_SECONDS,
  HEART_WAVE_PATH,
} from './heart-wave.ts'

export function ThinkingGapIndicator() {
  return (
    <div
      className="wc-thinking-gap mb-3 flex items-center gap-2 px-1 text-xs text-[var(--wc-faint)]"
      role="status"
      aria-live="polite"
    >
      <svg
        className="wc-thinking-heart"
        viewBox="0 0 100 100"
        aria-hidden="true"
      >
        <g className="wc-thinking-heart-pulse">
          <path
            className="wc-thinking-heart-base"
            d={HEART_WAVE_PATH}
          />
          <path
            className="wc-thinking-heart-flow"
            d={HEART_WAVE_PATH}
            pathLength={100}
            strokeDasharray={`${HEART_WAVE_FLOW_SPAN} ${100 - HEART_WAVE_FLOW_SPAN}`}
            style={{ animationDuration: `${HEART_WAVE_LOOP_SECONDS}s` }}
          />
        </g>
      </svg>
      <span>正在思考</span>
    </div>
  )
}
