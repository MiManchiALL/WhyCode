import type { Stats } from 'node:fs'
import { lstat, mkdir, readdir, rm, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { validateSessionId } from '@whycode/core'
import { copyDirectorySnapshot } from './directory-snapshot.ts'

export interface SessionScratchPaths {
  rootDirectory: string
  mainDirectory: string
}

export interface SessionScratchCleanupResult {
  removed: string[]
  warnings: string[]
}

/** 会话 scratch 的单一所有权入口；目录身份只由稳定 sessionId 派生。 */
export class SessionScratchManager {
  readonly rootDirectory: string

  constructor(rootDirectory: string) {
    this.rootDirectory = resolve(rootDirectory)
  }

  paths(sessionId: string): SessionScratchPaths {
    validateSessionId(sessionId)
    const rootDirectory = join(this.rootDirectory, sessionId)
    return {
      rootDirectory,
      mainDirectory: join(rootDirectory, 'Main'),
    }
  }

  async ensure(sessionId: string): Promise<SessionScratchPaths> {
    const paths = this.paths(sessionId)
    await this.ensureRoot()
    await mkdir(paths.rootDirectory, { recursive: true, mode: 0o700 })
    await assertOrdinaryDirectory(paths.rootDirectory)
    await mkdir(paths.mainDirectory, { recursive: true, mode: 0o700 })
    await assertOrdinaryDirectory(paths.mainDirectory)
    return paths
  }

  async snapshot(
    sourceSessionId: string,
    targetSessionId: string,
  ): Promise<SessionScratchPaths> {
    const source = await this.ensure(sourceSessionId)
    const target = this.paths(targetSessionId)
    await this.ensureRoot()
    await mkdir(target.rootDirectory, { recursive: false, mode: 0o700 })
    try {
      await copyDirectorySnapshot(source.rootDirectory, target.rootDirectory)
      await assertOrdinaryDirectory(target.mainDirectory)
      return target
    } catch (error) {
      try {
        await removeEntry(target.rootDirectory)
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          '创建会话临时工作区快照失败且未能完整清理目标目录',
        )
      }
      throw error
    }
  }

  async remove(sessionId: string): Promise<void> {
    await this.ensureRoot()
    await removeEntry(this.paths(sessionId).rootDirectory)
  }

  async cleanupAbandoned(
    activeSessionIds: ReadonlySet<string>,
  ): Promise<SessionScratchCleanupResult> {
    const result: SessionScratchCleanupResult = { removed: [], warnings: [] }
    await this.ensureRoot()
    for (const name of await readdir(this.rootDirectory)) {
      if (activeSessionIds.has(name)) continue
      try {
        await removeEntry(join(this.rootDirectory, name))
        result.removed.push(name)
      } catch (error) {
        result.warnings.push(
          `${name}：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return result
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 })
    await assertOrdinaryDirectory(this.rootDirectory)
  }
}

async function assertOrdinaryDirectory(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`会话临时工作区路径不是普通目录：${path}`)
  }
}

async function removeEntry(path: string): Promise<void> {
  let info: Stats
  try {
    info = await lstat(path)
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    await unlink(path)
    return
  }
  await rm(path, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
