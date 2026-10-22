import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  mkdir,
  open,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { TextDecoder } from 'node:util'
import { localWorkspaceIO } from '../workspace/io.ts'
import { readBoundedWorkspaceFile } from '../workspace/read.ts'

export const MCP_CONFIG_MAX_BYTES = 256 * 1024

export async function ensureMcpFile(path: string, template: string): Promise<void> {
  try {
    await access(path, constants.F_OK)
    return
  } catch {
    // 缺失时创建；已有但暂时不可读的文件不能被覆盖。
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const handle = await open(path, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') return null
    throw error
  })
  if (!handle) return
  try {
    await handle.writeFile(template, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function readMcpConfigBytes(path: string, io = localWorkspaceIO): Promise<Buffer> {
  return readBoundedWorkspaceFile(path, MCP_CONFIG_MAX_BYTES, io)
}

export function decodeMcpConfig(
  bytes: Buffer,
): { ok: true; value: unknown } | { ok: false; error: string } {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { ok: false, error: '配置必须是有效的 UTF-8 文本' }
  }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, error: '配置不是合法 JSON' }
  }
}

export async function writeMcpConfig(path: string, value: unknown): Promise<void> {
  const directory = dirname(path)
  const temporaryPath = join(directory, `.mcp-${randomUUID()}.tmp`)
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (Buffer.byteLength(text) > MCP_CONFIG_MAX_BYTES) throw new Error('MCP 配置超过 256 KiB')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    await writeFile(temporaryPath, text, {
      mode: 0o600,
      flag: 'wx',
      flush: true,
    })
    await rename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {})
    throw error
  }
}
