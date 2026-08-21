import { randomUUID } from 'node:crypto'
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  SessionStore,
  subagentManifestSchema,
  validateSessionId,
  type SessionCreateInput,
  type SessionJournal,
  type SubagentManifest,
} from '@whycode/core'

const MANIFEST_FILE = 'subagent.json'

/** 子代理 transcript 与 manifest 的单一磁盘入口；目录严格嵌套在父会话之下。 */
export class SubagentStorage {
  private readonly sessionsRoot: string

  constructor(sessionsRoot: string) {
    this.sessionsRoot = resolve(sessionsRoot)
  }

  async create(
    parentSessionId: string,
    input: SessionCreateInput,
  ): Promise<SessionJournal> {
    const store = this.sessionStore(parentSessionId)
    return store.create(input)
  }

  async open(parentSessionId: string, subagentId: string): Promise<SessionJournal> {
    return this.sessionStore(parentSessionId).open(subagentId)
  }

  async remove(parentSessionId: string, subagentId: string): Promise<void> {
    await this.sessionStore(parentSessionId).delete(subagentId)
  }

  async readManifest(parentSessionId: string, subagentId: string): Promise<SubagentManifest> {
    validateSessionId(parentSessionId)
    validateSessionId(subagentId)
    const parsed = subagentManifestSchema.safeParse(JSON.parse(
      await readFile(this.manifestPath(parentSessionId, subagentId), 'utf8'),
    ))
    if (!parsed.success) throw new Error('子代理 manifest 无效')
    if (parsed.data.parentSessionId !== parentSessionId || parsed.data.id !== subagentId) {
      throw new Error('子代理 manifest 所有权不匹配')
    }
    return parsed.data
  }

  async writeManifest(manifest: SubagentManifest): Promise<void> {
    const parsed = subagentManifestSchema.parse(manifest)
    const directory = this.subagentDirectory(parsed.parentSessionId, parsed.id)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('子代理目录不是普通目录')
    }
    const target = join(directory, MANIFEST_FILE)
    const temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(parsed, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
      flush: true,
    })
    try {
      await rename(temporary, target)
    } catch (error) {
      if (!isWindowsReplaceError(error)) throw error
      await copyFile(temporary, target)
      await rm(temporary, { force: true })
    }
  }

  async listManifests(parentSessionId: string): Promise<SubagentManifest[]> {
    validateSessionId(parentSessionId)
    const root = this.subagentsDirectory(parentSessionId)
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    const manifests: SubagentManifest[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        validateSessionId(entry.name)
        manifests.push(await this.readManifest(parentSessionId, entry.name))
      } catch {}
    }
    return manifests.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async listAllManifests(): Promise<SubagentManifest[]> {
    const parents = await readdir(this.sessionsRoot, { withFileTypes: true }).catch(() => [])
    const manifests: SubagentManifest[] = []
    for (const parent of parents) {
      if (!parent.isDirectory()) continue
      try {
        validateSessionId(parent.name)
      } catch {
        continue
      }
      manifests.push(...await this.listManifests(parent.name))
    }
    return manifests
  }

  private sessionStore(parentSessionId: string): SessionStore {
    return new SessionStore(this.subagentsDirectory(parentSessionId))
  }

  private subagentsDirectory(parentSessionId: string): string {
    validateSessionId(parentSessionId)
    return join(this.sessionsRoot, parentSessionId, 'subagents')
  }

  private subagentDirectory(parentSessionId: string, subagentId: string): string {
    validateSessionId(subagentId)
    return join(this.subagentsDirectory(parentSessionId), subagentId)
  }

  private manifestPath(parentSessionId: string, subagentId: string): string {
    return join(this.subagentDirectory(parentSessionId, subagentId), MANIFEST_FILE)
  }
}

function isWindowsReplaceError(error: unknown): boolean {
  if (process.platform !== 'win32' || !(error instanceof Error)) return false
  return 'code' in error && (error.code === 'EPERM' || error.code === 'EEXIST')
}
