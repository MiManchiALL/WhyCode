import { z } from 'zod'
import type { WorkspaceIO } from '@whycode/core'
import type { RemoteProcessHost } from './process.ts'

const rangeNotice = z.union([
  z.object({ lines: z.int().nonnegative() }), z.object({ columns: z.int().nonnegative() }),
  z.object({ unreadable: z.enum(['not-file', 'binary']) }),
])

export function remoteTextReader(host: RemoteProcessHost, executable: string): NonNullable<WorkspaceIO['readTextWindow']> {
  return async (path, { offset, column, limit, maxBytes }, signal) => {
    signal.throwIfAborted()
    // path 为绝对路径，父目录缺失也应由已启动的读取器报告。
    const process = host.spawn({ executable, args: ['read-text', path, String(offset), String(column), String(limit ?? 0), String(maxBytes)] }, '/')
    const reply = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = []
      let bytes = 0, diagnostic = ''
      let failure: Error | undefined
      const cancel = () => { void process.terminate() }
      signal.addEventListener('abort', cancel, { once: true })
      process.stdout.on('data', (chunk: Buffer) => {
        if (failure) return
        bytes += chunk.length
        if (bytes > maxBytes + 128) {
          failure = new Error('远端文本范围响应超过限制')
          cancel()
        } else chunks.push(chunk)
      })
      process.stderr.setEncoding('utf8').on('data', (chunk: string) => { diagnostic = (diagnostic + chunk).slice(-2048) })
      process.once('error', error => { failure = error })
      process.once('close', code => {
        signal.removeEventListener('abort', cancel)
        if (signal.aborted) reject(signal.reason)
        else if (failure) reject(failure)
        else if (code === 3) reject(Object.assign(new Error('远端文件不存在'), { code: 'ENOENT', path }))
        else if (code !== 0) reject(new Error(diagnostic.trim() || '远端文本读取失败'))
        else resolve(Buffer.concat(chunks, bytes).toString('utf8'))
      })
      process.stdin.end()
    })
    return reply.startsWith('text\n') ? { text: reply.slice(5) } : rangeNotice.parse(JSON.parse(reply))
  }
}
