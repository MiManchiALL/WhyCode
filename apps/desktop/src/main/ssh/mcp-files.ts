import { z } from 'zod'
import {
  MCP_CONFIG_MAX_BYTES, MCP_PROJECT_CONFIG_TEMPLATE, readMcpConfigBytes,
  decodeMcpConfig, parseMcpConfig, formatMcpConfigError, getProjectMcpConfigPath,
  type WorkspaceIO,
} from '@whycode/core'
import type { RemoteMcpProject, RemoteMcpSelection } from '../../shared/ssh-mcp.ts'
import { remoteMcpProjectPathSchema } from '../../shared/ssh-mcp.ts'
import { exists, ordinaryDirectory, pruneEmptyParents } from './config-files.ts'
import { digest } from './provision.ts'
import { atomicSftpWrite } from './sftp.ts'

const indexSchema = z.object({ version: z.literal(1), projects: z.array(remoteMcpProjectPathSchema).max(1000) }).strict()

/** 调用方持有服务器账号的配置锁。索引仅记录路径，配置内容只存在于项目原文件。 */
export class RemoteMcpFiles {
  private readonly indexPath: string
  private readonly io: WorkspaceIO
  private readonly home: string
  constructor(io: WorkspaceIO, home: string) {
    this.io = io
    this.home = home
    this.indexPath = io.path.join(home, '.whycode', 'mcp-projects.json')
  }

  path(directory: string): string {
    remoteMcpProjectPathSchema.parse(directory)
    if (this.io.path.normalize(directory) !== directory) throw new Error('远端项目路径必须规范化')
    return getProjectMcpConfigPath(directory, this.io)
  }

  private async bytes(file: string): Promise<Buffer | null> {
    if (!await ordinaryDirectory(this.io, this.io.path.dirname(file))) return null
    const stat = await exists(this.io.fs, file)
    if (!stat) return null
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('MCP 配置不是普通文件')
    return readMcpConfigBytes(file, this.io)
  }

  private async index(): Promise<string[]> {
    // 索引发布前不会写项目文件；残留的索引暂存文件不承担恢复事实。
    for (const file of await this.temporaryFiles(this.indexPath)) await this.io.fs.unlink(file)
    const bytes = await this.bytes(this.indexPath)
    if (!bytes) return []
    const decoded = decodeMcpConfig(bytes)
    if (!decoded.ok) throw new Error(`MCP 项目索引：${decoded.error}`)
    const { projects } = indexSchema.parse(decoded.value)
    for (const directory of projects) this.path(directory)
    return [...new Set(projects)].sort()
  }

  private async temporaryFiles(file: string): Promise<string[]> {
    const directory = this.io.path.dirname(file)
    if (!await ordinaryDirectory(this.io, directory)) return []
    const prefix = this.io.path.basename(file) + '.'
    const names = (await this.io.fs.readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.name.startsWith(prefix) && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tmp$/u.test(entry.name.slice(prefix.length)))
      .map(entry => this.io.path.join(directory, entry.name)).sort()
    if (names.length > 100) throw new Error('MCP 暂存文件过多，请检查远端目录')
    for (const temporary of names) {
      const info = await this.io.fs.lstat(temporary)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('MCP 暂存文件不是普通文件')
    }
    return names
  }

  private async inspection(directory: string) {
    const file = this.path(directory)
    const bytes = await this.bytes(file)
    const temporary = await this.temporaryFiles(file)
    const staging = []
    for (const path of temporary) staging.push([path, digest((await this.bytes(path))!)])
    return { bytes, temporary, digest: bytes || temporary.length ? digest(Buffer.from(JSON.stringify([bytes ? digest(bytes) : null, staging]))) : null }
  }

  private async writeIndex(projects: readonly string[]): Promise<void> {
    const unique = [...new Set(projects)].sort()
    if (!unique.length) {
      await this.bytes(this.indexPath)
      await this.io.fs.rm(this.indexPath, { force: true })
      await pruneEmptyParents(this.io, this.io.path.dirname(this.indexPath), this.home)
      return
    }
    const text = JSON.stringify(indexSchema.parse({ version: 1, projects: unique }), null, 2) + '\n'
    if (Buffer.byteLength(text) > MCP_CONFIG_MAX_BYTES) throw new Error('MCP 项目索引已满')
    await ordinaryDirectory(this.io, this.io.path.dirname(this.indexPath), true)
    await atomicSftpWrite(this.io.fs, this.indexPath, Buffer.from(text), 0o600)
  }

  async load(directory: string): Promise<Buffer> {
    const bytes = await this.bytes(this.path(directory))
    if (!bytes) throw Object.assign(new Error('项目 MCP 配置不存在'), { code: 'ENOENT' })
    const projects = await this.index()
    if (!projects.includes(directory)) await this.writeIndex([...projects, directory])
    return bytes
  }

  async read(directory: string): Promise<{ text: string; digest: string | null }> {
    const bytes = await this.load(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!bytes) return { text: MCP_PROJECT_CONFIG_TEMPLATE, digest: null }
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), digest: digest(bytes) }
  }

  async save(directory: string, text: string, expected: string | null): Promise<{ text: string; digest: string }> {
    const bytes = Buffer.from(text)
    if (bytes.length > MCP_CONFIG_MAX_BYTES) throw new Error('MCP 配置超过 256 KiB')
    const decoded = decodeMcpConfig(bytes)
    if (!decoded.ok) throw new Error(decoded.error)
    try { parseMcpConfig(decoded.value) } catch (error) { throw new Error(formatMcpConfigError(error)) }
    const file = this.path(directory)
    const current = await this.bytes(file)
    if ((current ? digest(current) : null) !== expected) throw new Error('配置已在其它位置修改，请重新打开后编辑')
    if (!await ordinaryDirectory(this.io, directory)) throw new Error('远端项目目录不存在')
    const projects = await this.index()
    if (!projects.includes(directory)) await this.writeIndex([...projects, directory])
    try {
      await ordinaryDirectory(this.io, this.io.path.dirname(file), true)
      await atomicSftpWrite(this.io.fs, file, bytes, 0o600)
    } catch (error) {
      if (!await exists(this.io.fs, file) && !(await this.temporaryFiles(file)).length) {
        await this.writeIndex(projects)
        await pruneEmptyParents(this.io, this.io.path.dirname(file), directory)
      }
      throw error
    }
    return { text, digest: digest(bytes) }
  }

  async list(knownProjects: readonly string[]): Promise<RemoteMcpProject[]> {
    const indexed = await this.index()
    const retained: string[] = []
    const rows: RemoteMcpProject[] = []
    for (const directory of [...new Set([...indexed, ...knownProjects])].sort()) {
      this.path(directory)
      try {
        const state = await this.inspection(directory)
        if (!state.digest) continue
        retained.push(directory)
        rows.push({ directory, digest: state.digest, ...(state.temporary.length ? { incomplete: true } : {}) })
      } catch (error) {
        retained.push(directory)
        rows.push({ directory, error: error instanceof Error ? error.message : String(error) })
      }
    }
    if (!retained.length || JSON.stringify(indexed) !== JSON.stringify(retained)) await this.writeIndex(retained)
    return rows
  }

  async remove(selection: readonly RemoteMcpSelection[], beforeDelete: (directory: string) => Promise<void>): Promise<void> {
    let projects = await this.index()
    for (const item of selection) {
      if (!projects.includes(item.directory)) throw new Error('项目不在 MCP 管理列表中，请刷新后重试')
      const file = this.path(item.directory)
      const previous = await this.inspection(item.directory)
      if (previous.digest && previous.digest !== item.digest) throw new Error('配置已变化，请刷新后重新确认删除')
      await beforeDelete(item.directory)
      const current = await this.inspection(item.directory)
      if (current.digest !== previous.digest) throw new Error('配置已变化，请刷新后重新确认删除')
      if (current.bytes) await this.io.fs.unlink(file)
      for (const temporary of current.temporary) await this.io.fs.unlink(temporary)
      await pruneEmptyParents(this.io, this.io.path.dirname(file), item.directory)
      projects = projects.filter(directory => directory !== item.directory)
      await this.writeIndex(projects)
    }
  }
}
