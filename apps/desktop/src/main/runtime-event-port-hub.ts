import type { RuntimeEventBatch } from '../shared/session.ts'

export interface RuntimeEventPort {
  close: () => void
  postMessage: (message: RuntimeEventBatch) => void
  start: () => void
  once: (event: 'close', listener: () => void) => unknown
}

export interface RuntimeEventPortHubOptions {
  onPublishError?: (error: unknown) => void
}

/** 每个 WebContents 只保留一条长期流端口；页面重载或重订阅时原子替换。 */
export class RuntimeEventPortHub {
  private readonly ports = new Map<number, RuntimeEventPort>()
  private readonly onPublishError: (error: unknown) => void

  constructor(options: RuntimeEventPortHubOptions = {}) {
    this.onPublishError = options.onPublishError ?? (() => undefined)
  }

  attach(ownerId: number, port: RuntimeEventPort): void {
    this.detach(ownerId)
    this.ports.set(ownerId, port)
    port.once('close', () => {
      if (this.ports.get(ownerId) === port) this.ports.delete(ownerId)
    })
    port.start()
  }

  detach(ownerId: number): void {
    const port = this.ports.get(ownerId)
    if (!port) return
    this.ports.delete(ownerId)
    port.close()
  }

  publish(batch: RuntimeEventBatch): void {
    for (const [ownerId, port] of this.ports) {
      try {
        port.postMessage(batch)
      } catch (error) {
        this.ports.delete(ownerId)
        port.close()
        this.onPublishError(error)
      }
    }
  }

  closeAll(): void {
    for (const ownerId of [...this.ports.keys()]) this.detach(ownerId)
  }
}
