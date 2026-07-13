import { resolve } from 'node:path'
import {
  captureFileState,
  currentFileMatches,
  restoreFileState,
} from './file-history.ts'
import type { CheckpointManifest, FileState } from './types.ts'

function pathKey(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/** 单次资源回滚事务。manifest 状态提交由上层负责，本类只处理文件系统的原子性。 */
export class ResourceRestoreTransaction {
  private readonly manifests: CheckpointManifest[]
  private readonly blobDir: string
  private readonly safety = new Map<string, FileState>()

  constructor(options: { manifests: CheckpointManifest[]; blobDir: string }) {
    this.manifests = options.manifests
    this.blobDir = options.blobDir
  }

  async apply(): Promise<void> {
    await this.captureSafety()
    await this.preflight()
    await this.applyReverse()
    await this.verifyFinal()
  }

  async compensate(): Promise<void> {
    for (const state of this.safety.values()) {
      await restoreFileState(state, this.blobDir)
    }
  }

  private async captureSafety(): Promise<void> {
    for (const manifest of this.manifests) {
      for (const resource of manifest.resources) {
        if (resource.kind !== 'exact-file') throw unsupportedLegacyCheckpoint()
        const key = pathKey(resource.path)
        if (!this.safety.has(key)) {
          this.safety.set(key, await captureFileState(resource.path, this.blobDir))
        }
      }
    }
  }

  /** 只比较每个路径最后一次 Agent 写入后的状态；更早状态由不可变 manifest 链保证。 */
  private async preflight(): Promise<void> {
    const seen = new Set<string>()
    for (const manifest of [...this.manifests].reverse()) {
      for (const resource of [...manifest.resources].reverse()) {
        if (resource.kind !== 'exact-file') throw unsupportedLegacyCheckpoint()
        if (!resource.after) throw new Error('精确文件检查点损坏')
        const key = pathKey(resource.path)
        if (seen.has(key)) continue
        seen.add(key)
        if (!await currentFileMatches(resource.after)) {
          throw new Error(`文件在 Agent 操作后又被修改，已拒绝覆盖：${resource.path}`)
        }
      }
    }
  }

  private async applyReverse(): Promise<void> {
    for (const manifest of [...this.manifests].reverse()) {
      for (const resource of [...manifest.resources].reverse()) {
        if (resource.kind !== 'exact-file') throw unsupportedLegacyCheckpoint()
        await restoreFileState(resource.before, this.blobDir)
      }
    }
  }

  private async verifyFinal(): Promise<void> {
    const expected = new Map<string, FileState>()
    for (const manifest of [...this.manifests].reverse()) {
      for (const resource of manifest.resources) {
        if (resource.kind !== 'exact-file') throw unsupportedLegacyCheckpoint()
        expected.set(pathKey(resource.path), resource.before)
      }
    }
    for (const state of expected.values()) {
      if (!await currentFileMatches(state)) {
        throw new Error(`回滚校验失败：${state.path}`)
      }
    }
  }
}

function unsupportedLegacyCheckpoint(): Error {
  return new Error('旧版 RunCommand 检查点已不支持回滚')
}
