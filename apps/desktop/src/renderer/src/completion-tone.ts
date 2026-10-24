/** 单次短音拥有自己的音频资源；重复完成合并，结束、禁用或卸载立即释放。 */
export class CompletionTone {
  private context: AudioContext | null = null
  private disconnect: (() => void) | null = null
  private readonly createContext: () => AudioContext

  constructor(createContext: () => AudioContext = () => new AudioContext()) { this.createContext = createContext }

  async play(): Promise<void> {
    if (this.context) return
    const context = this.createContext()
    this.context = context
    try {
      await context.resume()
      if (this.context !== context) return
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      this.disconnect = () => { oscillator.onended = null; oscillator.disconnect(); gain.disconnect() }
      const now = context.currentTime
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(440, now)
      oscillator.frequency.exponentialRampToValueAtTime(880, now + 0.18)
      gain.gain.setValueAtTime(0, now)
      gain.gain.linearRampToValueAtTime(0.08, now + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.32)
      gain.gain.linearRampToValueAtTime(0, now + 0.35)
      oscillator.connect(gain)
      gain.connect(context.destination)
      oscillator.onended = () => { if (this.context === context) this.stop() }
      oscillator.start(now)
      oscillator.stop(now + 0.35)
    } catch (error) {
      if (this.context !== context) return // 等待音频设备时已取消。
      this.stop()
      throw error
    }
  }

  stop(): void {
    const context = this.context
    this.context = null
    this.disconnect?.()
    this.disconnect = null
    if (context && context.state !== 'closed') {
      void context.close().catch(error => console.warn('无法关闭完成提示音设备', error))
    }
  }
}
