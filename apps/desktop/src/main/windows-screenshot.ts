import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

interface WindowCaptureSource {
  id: string
  name: string
  size: { width: number; height: number }
  launched: boolean
}

export function withWindowsScreenshotWindow<T>(
  windowTitle: string,
  applicationPath: string | undefined,
  signal: AbortSignal,
  capture: (source: WindowCaptureSource, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted()
  const lifetime = new AbortController()
  const captureSignal = AbortSignal.any([signal, lifetime.signal])
  const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'windows-screenshot-worker.js')], {
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  return new Promise<T>((resolve, reject) => {
    let value: T
    let failure: Error | undefined
    let prepared = false
    let restored = false
    let captured = false
    let stderr = ''
    const send = (message: object) => {
      if (child.connected) child.send(message, error => { if (error) failure ??= error })
    }
    const cancel = () => {
      failure ??= new Error('截图已取消')
      send({ type: 'cancel' })
    }
    child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2000) })
    child.once('error', error => { failure = error })
    child.once('spawn', () => {
      send({ type: 'prepare', windowTitle, applicationPath })
      if (signal.aborted) cancel()
    })
    child.on('message', async message => {
      const result = message as WindowCaptureSource & { type: string; error?: string }
      if (result.type === 'restored') {
        restored = true
        if (result.error) failure = new Error(result.error)
        lifetime.abort(failure ?? new Error('窗口截图事务已结束'))
      } else if (result.type === 'prepared' && !prepared) {
        prepared = true
        try {
          signal.throwIfAborted()
          value = await capture(result, captureSignal)
          captureSignal.throwIfAborted()
          captured = true
        } catch (error) {
          failure ??= error instanceof Error ? error : new Error(String(error))
        } finally { send({ type: 'release' }) }
      }
    })
    child.once('close', code => {
      signal.removeEventListener('abort', cancel)
      lifetime.abort(new Error('窗口截图辅助进程已退出'))
      if (failure) reject(failure)
      else if (!restored || !captured || code !== 0) reject(new Error(`窗口截图辅助进程未正常完成${stderr.trim() ? `：${stderr.trim()}` : ''}`))
      else resolve(value)
    })
    signal.addEventListener('abort', cancel, { once: true })
  })
}
