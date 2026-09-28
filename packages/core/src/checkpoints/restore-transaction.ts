import { localWorkspaceIO, workspacePathKey, type WorkspaceIO } from '../workspace/io.ts'
import {
  captureFileState,
  currentFileMatches,
  restoreFileState,
} from './file-history.ts'
import type { CheckpointManifest, FileState } from './types.ts'

/** 单次资源回滚事务。manifest 状态提交由上层负责，本类只处理文件系统的原子性。 */
export class ResourceRestoreTransaction {
  private readonly manifests: CheckpointManifest[]
  private readonly blobDir: string
  private readonly io: WorkspaceIO
  private readonly safety = new Map<string, FileState>()

  constructor(options: { manifests: CheckpointManifest[]; blobDir: string; workspaceIO?: WorkspaceIO }) {
    this.io = options.workspaceIO ?? localWorkspaceIO
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
        const key = workspacePathKey(this.io, resource.path)
        if (seen.has(key)) continue
        seen.add(key)
        if (!await currentFileMatches(resource.after, this.io)) {
          throw new Error(`文件在 Agent 操作后又被修改，已拒绝覆盖：${resource.path}`)
        }
      }
    }
  }

  async compensate(): Promise<void> {
    for (const state of this.safety.values()) {
      await restoreFileState(state, this.blobDir, this.io)
    }
  }

  private async captureSafety(): Promise<void> {
    for (const manifest of this.manifests) {
      for (const resource of manifest.resources) {
        const key = workspacePathKey(this.io, resource.path)
        if (!this.safety.has(key)) {
          this.safety.set(key, await captureFileState(resource.path, this.blobDir, this.io))
        }
      }
    }
  }

  private async applyReverse(): Promise<void> {
    for (const manifest of [...this.manifests].reverse()) {
      for (const resource of [...manifest.resources].reverse()) {
        await restoreFileState(resource.before, this.blobDir, this.io)
      }
    }
  }

  private async verifyFinal(): Promise<void> {
    const expected = new Map<string, FileState>()
    for (const manifest of [...this.manifests].reverse()) {
      for (const resource of manifest.resources) {
        expected.set(workspacePathKey(this.io, resource.path), resource.before)
      }
    }
    for (const state of expected.values()) {
      if (!await currentFileMatches(state, this.io)) {
        throw new Error(`回滚校验失败：${state.path}`)
      }
    }
  }
}
