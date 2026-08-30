import type { RuntimeEventBatch } from '../../shared/session.ts'
import {
  RUNTIME_EVENT_PORT_READY_MESSAGE,
  RUNTIME_EVENT_PORT_REQUEST_MESSAGE,
} from '../../shared/runtime-event-port.ts'

/** 业务批次直接走原生 MessagePort，避免每次流更新都调用 contextBridge 代理。 */
export interface RuntimeEventSubscription {
  /** 首个端口就绪后再取快照，才能形成无缺口的“历史 + 实时流”边界。 */
  ready: Promise<void>
  unsubscribe: () => void
}

export function subscribeRuntimeEventBatches(
  listener: (events: RuntimeEventBatch) => void,
): RuntimeEventSubscription {
  let disposed = false
  let port: MessagePort | null = null
  let resolveReady: (() => void) | null = null
  const ready = new Promise<void>((resolve) => { resolveReady = resolve })

  const requestPort = () => window.postMessage(RUNTIME_EVENT_PORT_REQUEST_MESSAGE, '*')
  const receivePort = (event: MessageEvent) => {
    if (
      event.source !== window
      || event.data !== RUNTIME_EVENT_PORT_READY_MESSAGE
    ) return
    const nextPort = event.ports[0]
    if (!nextPort) return
    if (disposed) {
      nextPort.close()
      return
    }
    port?.close()
    port = nextPort
    nextPort.onmessage = (message: MessageEvent<RuntimeEventBatch>) => {
      if (!Array.isArray(message.data)) return
      listener(message.data)
    }
    nextPort.onmessageerror = () => {
      if (port !== nextPort || disposed) return
      nextPort.close()
      port = null
      requestPort()
    }
    nextPort.start()
    resolveReady?.()
    resolveReady = null
  }

  window.addEventListener('message', receivePort)
  requestPort()
  return {
    ready,
    unsubscribe: () => {
      disposed = true
      window.removeEventListener('message', receivePort)
      port?.close()
      port = null
    },
  }
}
