import { access, copyFile, mkdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { CheckpointManifestStore } from '../checkpoints/manifest-store.ts'
import type { CheckpointManifest, FileState } from '../checkpoints/types.ts'
import type { WorkspaceBinding } from '../workspace/types.ts'
import type { LoadedSession, SessionEntry } from './types.ts'
import type { SessionPaths } from './metadata.ts'

export async function copyForkAttachments(
  source: SessionPaths,
  target: SessionPaths,
  loaded: LoadedSession,
): Promise<void> {
  const storageNames = new Set([
    ...loaded.imageAttachments.map((attachment) => attachment.storageName),
    ...loaded.pdfAttachments.map((attachment) => attachment.storageName),
  ])
  if (storageNames.size === 0) return
  await mkdir(target.attachments, { recursive: true, mode: 0o700 })
  await Promise.all([...storageNames].map((storageName) =>
    copyFile(join(source.attachments, storageName), join(target.attachments, storageName))))
}

export async function copyForkCheckpoints(
  source: SessionPaths,
  target: SessionPaths,
  entries: readonly SessionEntry[],
  targetSessionId: string,
  sourceWorkspace: WorkspaceBinding,
  targetWorkspace: WorkspaceBinding,
): Promise<void> {
  const turnIds = new Set(entries.flatMap((entry) =>
    entry.type === 'turn-start' ? [entry.turnId] : []))
  try {
    await access(join(source.checkpoints, 'manifests'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const sourceStore = new CheckpointManifestStore(source.checkpoints)
  const manifests = (await sourceStore.list()).filter((manifest) =>
    manifest.status !== 'pending' && turnIds.has(manifest.turnId))
  if (manifests.length === 0) return

  const targetStore = new CheckpointManifestStore(target.checkpoints)
  const blobHashes = new Set<string>()
  for (const manifest of manifests) {
    collectManifestBlobs(manifest, blobHashes)
    await targetStore.put(rehomeCheckpointManifest(
      manifest,
      targetSessionId,
      sourceWorkspace,
      targetWorkspace,
    ))
  }
  if (blobHashes.size === 0) return
  await mkdir(targetStore.blobDir, { recursive: true, mode: 0o700 })
  await Promise.all([...blobHashes].map((hash) =>
    copyFile(join(sourceStore.blobDir, hash), join(targetStore.blobDir, hash))))
}

function rehomeCheckpointManifest(
  manifest: CheckpointManifest,
  targetSessionId: string,
  sourceWorkspace: WorkspaceBinding,
  targetWorkspace: WorkspaceBinding,
): CheckpointManifest {
  const rebase = forkWorkspacePathMapper(sourceWorkspace, targetWorkspace)
  return {
    ...manifest,
    sessionId: targetSessionId,
    resources: manifest.resources.map((resource) => ({
      ...resource,
      path: rebase(resource.path),
      before: rehomeFileState(resource.before, rebase),
      ...(resource.after
        ? { after: rehomeFileState(resource.after, rebase) }
        : {}),
    })),
  }
}

function rehomeFileState(
  state: FileState,
  rebase: (path: string) => string,
): FileState {
  return {
    ...state,
    path: rebase(state.path),
    missingParents: state.missingParents.map(rebase),
  }
}

/** 只有受管快照复制文件；共享项目、外部文件及相对输入保留原义。 */
export function forkWorkspacePathMapper(source: WorkspaceBinding, target: WorkspaceBinding): (path: string) => string {
  if (source.mode !== 'managed' || target.mode !== 'managed') return path => path
  return path => {
    if (!isAbsolute(path)) return path
    const child = relative(resolve(source.workingDirectory), resolve(path))
    const outside = child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)
    return outside ? path : resolve(target.workingDirectory, child)
  }
}

function collectManifestBlobs(manifest: CheckpointManifest, hashes: Set<string>): void {
  for (const resource of manifest.resources) {
    collectStateBlob(resource.before, hashes)
    if (resource.after) collectStateBlob(resource.after, hashes)
  }
}

function collectStateBlob(state: FileState, hashes: Set<string>): void {
  if (state.blobHash) hashes.add(state.blobHash)
}
