import type { Client } from 'ssh2'
import type { SkillTreeManifest } from './skill-files.ts'
import { execChannel, quoteShell } from './provision.ts'

const COMPLETE = 'WHYCODE_SKILL_DIGEST_COMPLETE\n'

/** 目录与预算由 SFTP 校验；资源字节只在服务器流入 sha256sum，不下载或落临时文件。 */
export async function remoteSkillDigest(client: Client, manifest: SkillTreeManifest): Promise<string> {
  const lines = ['{']
  for (const directory of manifest.directories) lines.push(`printf '%s\\000' 'd' ${quoteShell(directory)} || exit 1`)
  for (const file of manifest.files) {
    const path = quoteShell(file.absolute)
    lines.push(
      `[ -f ${path} ] && [ ! -L ${path} ] || exit 1`,
      `printf '%s\\000' 'f' ${quoteShell(file.path)} '${file.mode}' '${file.size}' || exit 1`,
      // 多读一字节使增长产生不同摘要，同时限制并发修改后的读取量。
      `head -c ${file.size + 1} -- ${path} || exit 1`,
    )
  }
  // POSIX 管道默认只返回末端退出码，完成标记防止前端读取失败被当作有效摘要。
  lines.push(`printf ${quoteShell(COMPLETE)} >&2`, '} | sha256sum', '')
  const channel = await execChannel(client, '/bin/sh -s')
  return new Promise((resolve, reject) => {
    let output = ''
    let errors = ''
    const fail = (message: string) => { clearTimeout(timer); reject(new Error(message)); channel.close() }
    const timer = setTimeout(() => fail('远端 Skill 内容校验超时，请重试'), 30_000)
    channel.on('data', (chunk: Buffer) => {
      if (output.length + chunk.length > 256) fail('远端 Skill 内容校验输出异常')
      else output += chunk.toString('utf8')
    })
    channel.stderr.on('data', (chunk: Buffer) => {
      if (errors.length + chunk.length > 4096) fail('远端 Skill 内容校验失败，请检查文件读取权限和 sha256sum')
      else errors += chunk.toString('utf8')
    })
    channel.once('error', (error: Error) => { clearTimeout(timer); reject(error) })
    channel.once('close', (code: number) => {
      clearTimeout(timer)
      const digest = /^([a-f0-9]{64}) [ *]-\r?\n?$/u.exec(output)?.[1]
      if (code !== 0 || errors !== COMPLETE || !digest) reject(new Error('远端 Skill 内容校验失败，文件可能已变化；请检查读取权限和 sha256sum 后重试'))
      else resolve(digest)
    })
    channel.end(lines.join('\n'))
  })
}
