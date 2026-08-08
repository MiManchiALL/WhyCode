const HEART_WAVE = {
  pathSteps: 480,
  loopSeconds: 3,
  flowSpan: 18,
  b: 2,
  rootSpan: 3.3,
  waveAmplitude: 0.9,
  scaleX: 23.2,
  scaleY: 24.5,
  // 原实现的呼吸值在 0.52～1.00 间变化；中点路径交给 CSS 做同幅度缩放。
  detailScale: 0.76,
} as const

export const HEART_WAVE_LOOP_SECONDS = HEART_WAVE.loopSeconds
export const HEART_WAVE_FLOW_SPAN = HEART_WAVE.flowSpan
export const HEART_WAVE_PATH = createHeartWavePath()

function createHeartWavePath(): string {
  return Array.from({ length: HEART_WAVE.pathSteps + 1 }, (_, index) => {
    const point = heartWavePoint(index / HEART_WAVE.pathSteps)
    return `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`
  }).join(' ')
}

function heartWavePoint(progress: number): { x: number; y: number } {
  const xLimit = Math.sqrt(HEART_WAVE.rootSpan)
  const x = -xLimit + progress * xLimit * 2
  const root = Math.sqrt(Math.max(0, HEART_WAVE.rootSpan - x * x))
  const wave = HEART_WAVE.waveAmplitude
    * root
    * Math.sin(HEART_WAVE.b * Math.PI * x)
  const curve = Math.abs(x) ** (2 / 3) + wave
  const scaleY = HEART_WAVE.scaleY + HEART_WAVE.detailScale * 1.5
  return {
    x: 50 + x * HEART_WAVE.scaleX,
    y: 18 + (1.75 - curve) * scaleY,
  }
}
