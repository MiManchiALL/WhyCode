import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ManagedWorkspaceBinding } from '@whycode/core'
import type { WorkspaceRetention } from '../shared/workspace-lifecycle.ts'
import { assertWorkspaceDirectory, parseWorkspaceRetention } from './workspace-retention.ts'
import { samePath } from './workspace-path.ts'
import { WorkspaceOwnershipError } from './workspace-ownership-error.ts'

export interface ManagedWorkspaceManifest {
  schemaVersion: 3
  id: string
  workingDirectory: string
  createdAt: string
  sessionIds: string[]
  retention: WorkspaceRetention | null
}

export class ManagedWorkspaceStore {
  private readonly rootDirectory: string
  private readonly manifestDirectory: string

  constructor(rootDirectory: string, manifestDirectory: string) {
    this.rootDirectory = rootDirectory
    this.manifestDirectory = manifestDirectory
  }

  plannedDirectory(id: string): string {
    assertUuid(id)
    return join(this.rootDirectory, id)
  }

  async create(id: string): Promise<ManagedWorkspaceBinding> {
    const workingDirectory = this.plannedDirectory(id)
    const manifest: ManagedWorkspaceManifest = {
      schemaVersion: 3,
      id,
      workingDirectory,
      createdAt: new Date().toISOString(),
      sessionIds: [],
      retention: null,
    }
    await mkdir(this.manifestDirectory, { recursive: true, mode: 0o700 })
    await writeFile(this.manifestPath(id), JSON.stringify(manifest), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
      flush: true,
    })
    try {
      await mkdir(workingDirectory, { recursive: false, mode: 0o700 })
      const canonical = await realpath(workingDirectory)
      if (!samePath(canonical, workingDirectory)) {
        throw new Error(`默认工作区规范路径不一致：${canonical}`)
      }
      return bindingFromManifest(manifest)
    } catch (error) {
      await rm(this.manifestPath(id), { force: true }).catch(() => undefined)
      throw error
    }
  }

  async removeDirectory(manifest: ManagedWorkspaceManifest): Promise<void> {
    const expected = this.plannedDirectory(manifest.id)
    if (!samePath(manifest.workingDirectory, expected)) {
      throw new WorkspaceOwnershipError(`默认工作区 manifest 路径越界：${manifest.workingDirectory}`)
    }
    try {
      if (await assertWorkspaceDirectory(expected)) {
        await rm(expected, { recursive: true, force: false, maxRetries: 5, retryDelay: 100 })
      }
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
    await rm(this.manifestPath(manifest.id), { force: true })
  }

  async read(id: string): Promise<ManagedWorkspaceManifest> {
    const text = await readFile(this.manifestPath(id), 'utf8')
    try {
      const manifest = parseManifest(text)
      if (manifest.id !== id || !samePath(manifest.workingDirectory, this.plannedDirectory(id))) {
        throw new Error('默认工作区 manifest 身份或路径不一致')
      }
      return manifest
    } catch (error) {
      throw new WorkspaceOwnershipError(errorMessage(error))
    }
  }

  async readAll(warnings: string[] = []): Promise<ManagedWorkspaceManifest[]> {
    let names: string[]
    try {
      names = await readdir(this.manifestDirectory)
    } catch (error) {
      if (isNotFound(error)) return []
      throw error
    }
    const manifests: ManagedWorkspaceManifest[] = []
    for (const name of names.filter((value) => value.endsWith('.json'))) {
      try {
        const manifest = await this.read(name.slice(0, -5))
        manifests.push(manifest)
      } catch (error) {
        warnings.push(`${name}：${errorMessage(error)}`)
      }
    }
    return manifests
  }

  async write(manifest: ManagedWorkspaceManifest): Promise<void> {
    const target = this.manifestPath(manifest.id)
    const temporary = `${target}.${crypto.randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(manifest), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
      flush: true,
    })
    try {
      await rename(temporary, target)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  removeManifest(id: string): Promise<void> {
    return rm(this.manifestPath(id), { force: true })
  }

  private manifestPath(id: string): string {
    assertUuid(id)
    return join(this.manifestDirectory, `${id}.json`)
  }
}

export function bindingFromManifest(manifest: ManagedWorkspaceManifest): ManagedWorkspaceBinding {
  return {
    mode: 'managed',
    id: manifest.id,
    workingDirectory: manifest.workingDirectory,
    createdAt: manifest.createdAt,
  }
}

export function assertSameBinding(
  manifest: ManagedWorkspaceManifest,
  binding: ManagedWorkspaceBinding,
): void {
  if (
    manifest.id !== binding.id
    || manifest.createdAt !== binding.createdAt
    || !samePath(manifest.workingDirectory, binding.workingDirectory)
  ) throw new WorkspaceOwnershipError('默认工作区绑定与 manifest 不一致')
}

function parseManifest(text: string): ManagedWorkspaceManifest {
  const value: unknown = JSON.parse(text)
  if (
    !value
    || typeof value !== 'object'
    || (value as ManagedWorkspaceManifest).schemaVersion !== 3
    || typeof (value as ManagedWorkspaceManifest).id !== 'string'
    || typeof (value as ManagedWorkspaceManifest).workingDirectory !== 'string'
    || typeof (value as ManagedWorkspaceManifest).createdAt !== 'string'
    || !Array.isArray((value as ManagedWorkspaceManifest).sessionIds)
  ) throw new Error('默认工作区 manifest 无效')
  const manifest = value as ManagedWorkspaceManifest
  manifest.retention = parseWorkspaceRetention(manifest.retention)
  if (manifest.retention && manifest.sessionIds.length) throw new Error('保留工作区仍有关联会话')
  assertUuid(manifest.id)
  for (const sessionId of manifest.sessionIds) assertUuid(sessionId)
  return manifest
}

function assertUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error(`默认工作区 ID 无效：${value}`)
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
