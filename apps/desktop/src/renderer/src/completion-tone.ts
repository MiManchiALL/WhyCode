interface ToneNode { oscillator: OscillatorNode; gain: GainNode }

const DEVICE_WARMUP_SECONDS = 0.5
const DEVICE_IDLE_SECONDS = 10

/** 窗口持有设备，短音持有节点；自动完成合并，主动试听重新起音。 */
export class CompletionTone {
  private context: AudioContext | null = null
  private playback: object | null = null
  private readonly nodes = new Set<ToneNode>()
  private readyAt = 0
  private idle: { timer: ReturnType<typeof setTimeout>; deadline: number } | null = null
  private readonly createContext: () => AudioContext

  constructor(createContext: () => AudioContext = () => new AudioContext({ latencyHint: 'interactive' })) {
    this.createContext = createContext
  }

  async play(restart = false): Promise<void> {
    if (this.playback && !restart) return
    // 后台窗口的计时器可能迟到；已闲置的设备仍按冷启动处理。
    if (this.idle && this.context && this.context.currentTime >= this.idle.deadline) this.stop()
    const playback = {}
    this.playback = playback
    this.clearIdleTimer()
    try {
      if (!this.context) {
        this.context = this.createContext()
        this.readyAt = this.context.currentTime + DEVICE_WARMUP_SECONDS
      }
      const context = this.context
      if (context.state === 'suspended') this.readyAt = context.currentTime + DEVICE_WARMUP_SECONDS
      // 试听重播保留设备，只让旧音在 6ms 内收尾，避免硬切波形产生爆音。
      for (const { oscillator, gain } of this.nodes) {
        gain.gain.cancelAndHoldAtTime(context.currentTime)
        gain.gain.linearRampToValueAtTime(0, context.currentTime + 0.006)
        oscillator.stop(context.currentTime + 0.006)
      }
      await context.resume()
      if (this.playback !== playback) return
      // resume 完成不代表蓝牙耳机已经出声；先输出静音，让设备启动，再播放短音。
      // 连点试听沿用同一个就绪时刻，不把等待不断往后推。
      const start = Math.max(context.currentTime + 0.01, this.readyAt)
      const notes = [
        { frequency: 880, offset: 0, duration: 0.14, volume: 0.11 },
        { frequency: 1318.51, offset: 0.07, duration: 0.18, volume: 0.085 },
      ]
      for (const [index, note] of notes.entries()) {
        const oscillator = context.createOscillator()
        const gain = context.createGain()
        const node = { oscillator, gain }
        this.nodes.add(node)
        const at = start + note.offset
        oscillator.type = 'sine'
        oscillator.frequency.setValueAtTime(note.frequency, at)
        gain.gain.setValueAtTime(0, at)
        gain.gain.linearRampToValueAtTime(note.volume, at + 0.005)
        gain.gain.exponentialRampToValueAtTime(0.0001, at + note.duration - 0.01)
        gain.gain.linearRampToValueAtTime(0, at + note.duration)
        oscillator.connect(gain)
        gain.connect(context.destination)
        oscillator.onended = () => {
          this.releaseNode(node)
          if (index !== notes.length - 1 || this.playback !== playback) return
          this.playback = null
          // 保留一小段连续播放窗口，随后释放设备；不让耳机在每个短音之间休眠。
          this.idle = {
            deadline: context.currentTime + DEVICE_IDLE_SECONDS,
            timer: setTimeout(() => {
              if (this.context === context && !this.playback) this.stop()
            }, DEVICE_IDLE_SECONDS * 1000),
          }
        }
        oscillator.start(at)
        oscillator.stop(at + note.duration)
      }
    } catch (error) {
      if (this.playback !== playback) return
      this.stop()
      throw error
    }
  }

  stop(): void {
    this.playback = null
    this.clearIdleTimer()
    for (const node of this.nodes) this.releaseNode(node)
    const context = this.context
    this.context = null
    this.readyAt = 0
    if (context && context.state !== 'closed') {
      void context.close().catch(error => console.warn('无法关闭完成提示音设备', error))
    }
  }

  private releaseNode(node: ToneNode): void {
    node.oscillator.onended = null
    node.oscillator.disconnect()
    node.gain.disconnect()
    this.nodes.delete(node)
  }

  private clearIdleTimer(): void {
    if (this.idle) clearTimeout(this.idle.timer)
    this.idle = null
  }
}
