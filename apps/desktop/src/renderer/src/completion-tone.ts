interface ToneNode { oscillator: OscillatorNode; gain: GainNode }

/** 窗口持有设备，短音持有节点；自动完成合并，主动试听重新起音。 */
export class CompletionTone {
  private context: AudioContext | null = null
  private playback: object | null = null
  private readonly nodes = new Set<ToneNode>()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private readonly createContext: () => AudioContext

  constructor(createContext: () => AudioContext = () => new AudioContext({ latencyHint: 'interactive' })) {
    this.createContext = createContext
  }

  async play(restart = false): Promise<void> {
    if (this.playback && !restart) return
    const playback = {}
    this.playback = playback
    this.clearIdleTimer()
    try {
      const context = this.context ??= this.createContext()
      // 试听重播保留设备，只让旧音在 6ms 内收尾，避免硬切波形产生爆音。
      for (const { oscillator, gain } of this.nodes) {
        gain.gain.cancelAndHoldAtTime(context.currentTime)
        gain.gain.linearRampToValueAtTime(0, context.currentTime + 0.006)
        oscillator.stop(context.currentTime + 0.006)
      }
      await context.resume()
      if (this.playback !== playback) return
      const start = context.currentTime + 0.01
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
          // onended 表示渲染结束；等设备输出缓冲播放完，再暂停空闲设备。
          this.idleTimer = setTimeout(() => {
            this.idleTimer = null
            if (this.context === context && !this.playback) {
              void context.suspend().catch(error => {
                if (this.context === context) console.warn('无法暂停完成提示音设备', error)
              })
            }
          }, (context.baseLatency + context.outputLatency) * 1000 + 50)
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
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }
}
