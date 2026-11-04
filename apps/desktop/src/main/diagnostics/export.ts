import { createReadStream } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import type { DiagnosticFiles } from './files.ts'

/** 写入端暂停期间流式导出；临时文件只在用户选定的目标旁存在。 */
export async function exportDiagnostics(files: DiagnosticFiles, destination: string): Promise<void> {
  const inside = relative(files.directory, destination)
  if (!inside || (!isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))) {
    throw new Error('请选择诊断日志目录之外的导出位置')
  }
  const entries = await files.list()
  const temporary = join(dirname(destination), `.whycode-diagnostics-${randomUUID()}.tmp`)
  const output = await open(temporary, 'wx')
  let committed = false
  try {
    async function* contents() {
      yield JSON.stringify({ kind: 'diagnostic-export', version: 1, exportedAt: new Date().toISOString() }) + '\n'
      for (const entry of entries) {
        yield JSON.stringify({ kind: 'diagnostic-file', name: entry.name, bytes: entry.bytes }) + '\n'
        const input = createReadStream(join(files.directory, entry.name))
        try { for await (const chunk of input) yield chunk }
        finally { input.destroy() }
        yield '\n'
      }
    }
    await pipeline(Readable.from(contents()), createGzip(), output.createWriteStream())
    await rename(temporary, destination)
    committed = true
  } finally {
    await output.close()
    if (!committed) await unlink(temporary)
  }
}
