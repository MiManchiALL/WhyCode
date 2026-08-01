import { open } from 'node:fs/promises'

/** 以打开后的文件身份和固定长度读取，避免 stat/read 竞态绕过内存预算。 */
export async function readBoundedSkillFile(path: string, maxBytes: number): Promise<Buffer> {
  const file = await open(path, 'r')
  try {
    const metadata = await file.stat()
    if (!metadata.isFile()) throw new Error('Skill 路径必须指向普通文件')
    if (metadata.size > maxBytes) throw new Error(`Skill 文件超过 ${maxBytes} 字节上限`)
    const bytes = Buffer.alloc(metadata.size)
    let offset = 0
    while (offset < bytes.byteLength) {
      const { bytesRead } = await file.read(bytes, offset, bytes.byteLength - offset, offset)
      if (bytesRead === 0) throw new Error('读取 Skill 文件时内容发生变化')
      offset += bytesRead
    }
    const probe = Buffer.alloc(1)
    if ((await file.read(probe, 0, 1, metadata.size)).bytesRead > 0) {
      throw new Error('读取 Skill 文件时内容发生变化')
    }
    return bytes
  } finally {
    await file.close()
  }
}
