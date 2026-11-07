/** 编辑器订阅完整输入，宿主只订阅影响其布局的状态。 */
export class ComposerValue<T> {
  private value: T
  private readonly listeners = new Set<() => void>()

  constructor(value: T) { this.value = value }

  getSnapshot = (): T => this.value

  replace = (next: T): void => {
    if (next === this.value) return
    this.value = next
    for (const listener of this.listeners) listener()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

export class ComposerText extends ComposerValue<string> {
  constructor(text = '') { super(text) }

  isEmpty = (): boolean => !this.getSnapshot().trim()

  set = (text: string | ((current: string) => string)): void => {
    this.replace(typeof text === 'function' ? text(this.getSnapshot()) : text)
  }
}
