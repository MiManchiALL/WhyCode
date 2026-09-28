import * as fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'
import type { WorkspaceProcess } from './process.ts'

export interface WorkspaceStat {
  size: number
  mode: number
  dev?: number
  ino?: number
  mtimeMs?: number
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}
export interface WorkspaceDirent extends WorkspaceStat { name: string }
export interface WorkspaceReader {
  stat(): Promise<WorkspaceStat>
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
  close(): Promise<void>
}

/** Only workspace resources use this interface. Journals, credentials and blobs stay on the host. */
export interface WorkspaceFileSystem {
  stat(path: string): Promise<WorkspaceStat>
  lstat(path: string): Promise<WorkspaceStat>
  realpath(path: string): Promise<string>
  readFile(path: string): Promise<Buffer>
  readFile(path: string, encoding: 'utf8'): Promise<string>
  writeFile(path: string, data: string | Uint8Array, options?: 'utf8' | { mode?: number; flag?: string; flush?: boolean }): Promise<void>
  open(path: string, flags: 'r'): Promise<WorkspaceReader>
  createReadStream(path: string, options?: { encoding?: BufferEncoding; start?: number; end?: number; signal?: AbortSignal }): Readable
  readdir(path: string, options: { withFileTypes: true }): Promise<WorkspaceDirent[]>
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<unknown>
  rm(path: string, options: { force?: boolean; recursive?: boolean }): Promise<void>
  unlink(path: string): Promise<void>
  rmdir(path: string): Promise<void>
  rename(source: string, destination: string): Promise<void>
  copyFile(source: string, destination: string, mode?: number): Promise<void>
  chmod(path: string, mode: number): Promise<void>
}

export interface WorkspaceIO {
  /** Stable target identity, independent of display names and network reconnects. */
  readonly identity: string
  readonly platform: NodeJS.Platform
  readonly path: typeof path
  readonly fs: WorkspaceFileSystem
  spawn?: (command: string, cwd: string) => WorkspaceProcess
}

export const localWorkspaceIO: WorkspaceIO = {
  identity: 'local', platform: process.platform, path,
  fs: {
    ...fs,
    createReadStream,
    readdir: async (directory, options) => (await fs.readdir(directory, options)).map(entry => ({
      name: entry.name, size: 0, mode: 0,
      isFile: () => entry.isFile(), isDirectory: () => entry.isDirectory(),
      isSymbolicLink: () => entry.isSymbolicLink(),
    })),
  },
}

export function workspacePathKey(io: WorkspaceIO, value: string): string {
  const absolute = io.path.resolve(value)
  return io.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/** Resolve through existing ancestors as well, so a new file cannot escape via a symlink. */
async function canonicalPath(io: WorkspaceIO, value: string): Promise<string> {
  let candidate = io.path.resolve(value)
  const tail: string[] = []
  for (;;) {
    try { return io.path.join(await io.fs.realpath(candidate), ...tail) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = io.path.dirname(candidate)
      if (parent === candidate) throw error
      tail.unshift(io.path.basename(candidate))
      candidate = parent
    }
  }
}

export async function outsideWorkspaceBoundary(
  io: WorkspaceIO, input: string, project: string, additional: readonly string[],
): Promise<string | null> {
  if (input.includes('\0')) throw new Error('文件路径含有无效字符')
  const absolute = io.path.resolve(project, input)
  const canonical = await canonicalPath(io, absolute)
  for (const root of [project, ...additional]) {
    const resolved = io.path.resolve(project, root)
    if (within(io, resolved, absolute) && within(io, await canonicalPath(io, resolved), canonical)) return null
  }
  return absolute
}

function within(io: WorkspaceIO, root: string, value: string): boolean {
  const relative = io.path.relative(workspacePathKey(io, root), workspacePathKey(io, value))
  return relative === '' || (!io.path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${io.path.sep}`))
}
