/** 编辑器订阅全文；App 只订阅空值状态，发送和草稿保存直接读取最新文本。 */
export class ComposerText {
  private text: string
  private readonly listeners = new Set<() => void>()

  constructor(text = '') { this.text = text }

  getSnapshot = (): string => this.text
  isEmpty = (): boolean => !this.text.trim()

  set = (value: string | ((current: string) => string)): void => {
    const next = typeof value === 'function' ? value(this.text) : value
    if (next === this.text) return
    this.text = next
    for (const listener of this.listeners) listener()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}
