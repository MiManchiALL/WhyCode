import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { sshConnectionInputSchema, type SshConnection, type SshConnectionInput } from '../../shared/ssh.ts'
import type { ConfigSecretCodec } from '../config-storage.ts'

const storedSchema = sshConnectionInputSchema.omit({ secret: true }).extend({
  id: z.string().uuid(), fingerprint: z.string().optional(), encryptedSecret: z.string().optional(),
}).strict()
type StoredConnection = z.infer<typeof storedSchema>

/** Credentials never leave Main. A failed read/decryption must never overwrite saved data. */
export class SshConnectionStore {
  private transient = new Map<string, string>()
  private tail: Promise<unknown> = Promise.resolve()
  private readonly file: string
  private readonly codec: ConfigSecretCodec
  constructor(file: string, codec: ConfigSecretCodec) { this.file = file; this.codec = codec }

  private async read(): Promise<StoredConnection[]> {
    const data = await readFile(this.file, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '[]'
      throw error
    })
    try { return z.array(storedSchema).parse(JSON.parse(data)) }
    catch { throw new Error('SSH 连接配置无法读取，已保留原文件') }
  }
  async list(): Promise<SshConnection[]> { return (await this.read()).map(value => this.public(value)) }
  async get(id: string): Promise<{ connection: SshConnection; secret?: string }> {
    const stored = (await this.read()).find(value => value.id === id)
    if (!stored) throw new Error('SSH 连接不存在')
    let secret = this.transient.get(id)
    if (!secret && stored.encryptedSecret) {
      if (!this.codec.isAvailable()) throw new Error('系统密钥保护不可用')
      try { secret = this.codec.decrypt(stored.encryptedSecret) }
      catch { throw new Error('SSH 密钥无法解密，已保留原配置，请重新输入') }
    }
    return { connection: this.public(stored), secret }
  }
  save(value: SshConnectionInput): Promise<SshConnection> {
    const input = sshConnectionInputSchema.parse(value)
    if (input.authentication === 'key' && !input.privateKeyPath) throw new Error('请选择私钥文件')
    return this.update(async entries => {
      const existing = input.id ? entries.find(entry => entry.id === input.id) : undefined
      if (input.id && !existing) throw new Error('SSH 连接不存在')
      const { secret, ...settings } = input
      const id = existing?.id ?? randomUUID()
      const sameHost = existing?.host === input.host && existing.port === input.port
      const sameAuth = sameHost && existing?.username === input.username
        && existing.authentication === input.authentication && existing.privateKeyPath === input.privateKeyPath
      const cleartext = secret || (sameAuth ? (await this.get(id)).secret : undefined)
      let encryptedSecret: string | undefined
      if (cleartext && input.rememberSecret) {
        if (!this.codec.isAvailable()) throw new Error('系统密钥保护不可用，请取消记住密码')
        encryptedSecret = this.codec.encrypt(cleartext)
      }
      const stored: StoredConnection = { ...settings, id,
        ...(sameHost && existing?.fingerprint ? { fingerprint: existing.fingerprint } : {}),
        ...(encryptedSecret ? { encryptedSecret } : {}),
      }
      const updated = [...entries.filter(entry => entry.id !== id), stored]
      await this.write(updated)
      this.transient.delete(id)
      if (cleartext && !input.rememberSecret) this.transient.set(id, cleartext)
      return this.public(stored)
    })
  }
  trust(id: string, fingerprint: string): Promise<void> {
    return this.update(async entries => {
      const entry = entries.find(value => value.id === id)
      if (!entry) throw new Error('SSH 连接不存在')
      if (entry.fingerprint && entry.fingerprint !== fingerprint) throw new Error('服务器指纹已变化，连接已拒绝')
      entry.fingerprint = fingerprint
      await this.write(entries)
    })
  }
  remove(id: string): Promise<void> {
    return this.update(async entries => {
      await this.write(entries.filter(entry => entry.id !== id)); this.transient.delete(id)
    })
  }
  private public({ encryptedSecret, ...entry }: StoredConnection): SshConnection {
    return { ...entry, hasSecret: Boolean(encryptedSecret || this.transient.get(entry.id)) }
  }
  private update<T>(operation: (entries: StoredConnection[]) => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => operation(await this.read()))
    this.tail = result.catch(() => undefined)
    return result
  }
  private async write(entries: StoredConnection[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(entries, null, 2), { mode: 0o600, flag: 'wx', flush: true })
      await rename(temporary, this.file)
    } finally { await rm(temporary, { force: true }) }
  }
}
