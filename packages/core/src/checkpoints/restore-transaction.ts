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
    await this.validate()
    await this.applyReverse()
    await this.verifyFinal()
  }

  /** 只读校验当前文件仍与 Agent 最后一次写入一致；不会创建备份或修改资源。 */
  async validate(): Promise<void> {
    const seen = new Set<string>()
    for (const manifest of [...this.manifests].reverse()) {
      for (const resource of [...manifest.resources].reverse()) {
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

  async compensate(): Promise<void> {
    for (const state of this.safety.values()) {
      await restoreFileState(state, this.blobDir)
    }
  }

  private async captureSafety(): Promise<void> {
    for (const manifest of this.manifests) {
      for (const resource of manifest.resources) {
        const key = pathKey(resource.path)
        if (!this.safety.has(key)) {
          this.safety.set(key, await captureFileState(resource.path, this.blobDir))
        }
      }
    }
  }

  private async applyReverse(): Promise<void> {
    for (const manifest of [...this.manifests].reverse()) {
      for (const resource of [...manifest.resources].reverse()) {
        await restoreFileState(resource.before, this.blobDir)
      }
    }
  }

  private async verifyFinal(): Promise<void> {
    const expected = new Map<string, FileState>()
    for (const manifest of [...this.manifests].reverse()) {
      for (const resource of manifest.resources) {
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
