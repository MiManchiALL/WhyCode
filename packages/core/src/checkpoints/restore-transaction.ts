import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import {
  captureFileState,
  currentFileMatches,
  restoreFileState,
} from './file-history.ts'
import type { ShadowRepository } from './shadow-repository.ts'
import type { CheckpointManifest, FileState } from './types.ts'

interface TreeSafety {
  root: string
  hash: string
  paths: string[]
}

function pathKey(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/** 单次资源回滚事务。manifest 状态提交由上层负责，本类只处理文件系统的原子性。 */
export class ResourceRestoreTransaction {
  readonly id = randomUUID()
  private readonly manifests: CheckpointManifest[]
  private readonly blobDir: string
  private readonly sessionId: string
  private readonly repository: (root: string) => ShadowRepository
  private readonly exactSafety = new Map<string, FileState>()
  private readonly treeSafety = new Map<string, TreeSafety>()

  constructor(options: {
    manifests: CheckpointManifest[]
    blobDir: string
    sessionId: string
    repository: (root: string) => ShadowRepository
  }) {
    this.manifests = options.manifests
    this.blobDir = options.blobDir
    this.sessionId = options.sessionId
    this.repository = options.repository
  }

  async apply(): Promise<void> {
    await this.captureSafety()
    await this.preflight()
    await this.applyReverse()
    await this.verifyFinal()
  }

  async compensate(): Promise<void> {
    for (const safety of this.treeSafety.values()) {
      await this.repository(safety.root).restorePaths(safety.hash, safety.paths)
    }
    for (const state of this.exactSafety.values()) {
      await restoreFileState(state, this.blobDir)
    }
  }

  async releaseTransientRefs(): Promise<void> {
    const roots = new Map<string, string>()
    for (const manifest of this.manifests) {
      for (const resource of manifest.resources) {
        if (resource.kind === 'tree') roots.set(pathKey(resource.root), resource.root)
      }
    }
    await Promise.all([...roots.values()].map((root) =>
      this.repository(root).deleteCheckpointRefs(this.sessionId, this.id).catch(() => {}),
    ))
  }

  private async captureSafety(): Promise<void> {
    const treePaths = new Map<string, { root: string; paths: Set<string> }>()
    for (const manifest of this.manifests) {
      for (const resource of manifest.resources) {
        if (resource.kind === 'exact-file') {
          const key = pathKey(resource.path)
          if (!this.exactSafety.has(key)) {
            this.exactSafety.set(key, await captureFileState(resource.path, this.blobDir))
          }
          continue
        }
        const key = pathKey(resource.root)
        const entry = treePaths.get(key) ?? { root: resource.root, paths: new Set<string>() }
        for (const path of resource.changedPaths ?? []) entry.paths.add(path)
        treePaths.set(key, entry)
      }
    }
    for (const [key, entry] of treePaths) {
      this.treeSafety.set(key, {
        root: entry.root,
        hash: await this.repository(entry.root).capture(
          this.sessionId,
          this.id,
          `safety-${randomUUID()}`,
        ),
        paths: [...entry.paths],
      })
    }
  }

  /** 只比较每个路径最后一次 Agent 写入后的状态；更早状态由不可变 manifest 链保证。 */
  private async preflight(): Promise<void> {
    const seen = new Set<string>()
    for (const manifest of [...this.manifests].reverse()) {
      for (const resource of [...manifest.resources].reverse()) {
        if (resource.kind === 'exact-file') {
          if (!resource.after) throw new Error('精确文件检查点损坏')
          const key = pathKey(resource.path)
          if (seen.has(key)) continue
          seen.add(key)
          if (!await currentFileMatches(resource.after)) {
            throw new Error(`文件在 Agent 操作后又被修改，已拒绝覆盖：${resource.path}`)
          }
          continue
        }
        if (!resource.afterHash || !resource.changedPaths) throw new Error('树检查点损坏')
        const safety = this.treeSafety.get(pathKey(resource.root))
        if (!safety) throw new Error(`树检查点缺少安全快照：${resource.root}`)
        const paths = resource.changedPaths.filter((path) => {
          const key = pathKey(resolve(resource.root, path))
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        if (!await this.repository(resource.root).matchesSnapshot(
          resource.afterHash,
          safety.hash,
          paths,
        )) {
          throw new Error(`工作区在 Agent 操作后又被修改，已拒绝覆盖：${resource.root}`)
        }
      }
    }
  }

  private async applyReverse(): Promise<void> {
    for (const manifest of [...this.manifests].reverse()) {
      for (const resource of [...manifest.resources].reverse()) {
        if (resource.kind === 'exact-file') {
          await restoreFileState(resource.before, this.blobDir)
        } else {
          await this.repository(resource.root).restorePaths(
            resource.beforeHash,
            resource.changedPaths ?? [],
          )
        }
      }
    }
  }

  private async verifyFinal(): Promise<void> {
    const expected = new Map<
      string,
      { state: FileState } | { root: string; hash: string; path: string }
    >()
    for (const manifest of [...this.manifests].reverse()) {
      for (const resource of manifest.resources) {
        if (resource.kind === 'exact-file') {
          expected.set(pathKey(resource.path), { state: resource.before })
        } else {
          for (const path of resource.changedPaths ?? []) {
            expected.set(pathKey(resolve(resource.root, path)), {
              root: resource.root,
              hash: resource.beforeHash,
              path,
            })
          }
        }
      }
    }

    const trees = new Map<string, { root: string; hash: string; paths: string[] }>()
    for (const value of expected.values()) {
      if ('state' in value) {
        if (!await currentFileMatches(value.state)) {
          throw new Error(`回滚校验失败：${value.state.path}`)
        }
        continue
      }
      const key = `${pathKey(value.root)}\0${value.hash}`
      const entry = trees.get(key) ?? { root: value.root, hash: value.hash, paths: [] }
      entry.paths.push(value.path)
      trees.set(key, entry)
    }
    for (const tree of trees.values()) {
      const actual = await this.repository(tree.root).capture(
        this.sessionId,
        this.id,
        `verify-${randomUUID()}`,
      )
      if (!await this.repository(tree.root).matchesSnapshot(tree.hash, actual, tree.paths)) {
        throw new Error(`树回滚校验失败：${tree.root}`)
      }
    }
  }
}

