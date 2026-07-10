import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { checkpointManifestSchema, type CheckpointManifest } from './types.ts'

export class CheckpointManifestStore {
  readonly rootDir: string
  readonly blobDir: string
  private readonly manifestDir: string

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir)
    this.manifestDir = join(this.rootDir, 'manifests')
    this.blobDir = join(this.rootDir, 'blobs')
  }

  async list(): Promise<CheckpointManifest[]> {
    await mkdir(this.manifestDir, { recursive: true, mode: 0o700 })
    const entries = await readdir(this.manifestDir, { withFileTypes: true })
    const manifests = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => this.read(join(this.manifestDir, entry.name))),
    )
    return manifests.sort((left, right) => left.sequence - right.sequence)
  }

  async get(id: string): Promise<CheckpointManifest | null> {
    return this.read(this.pathFor(id)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
  }

  async put(manifest: CheckpointManifest): Promise<void> {
    const parsed = checkpointManifestSchema.parse(manifest)
    await mkdir(this.manifestDir, { recursive: true, mode: 0o700 })
    const target = this.pathFor(parsed.id)
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temp, `${JSON.stringify(parsed, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flush: true,
    })
    await rename(temp, target)
  }

  remove(id: string): Promise<void> {
    return rm(this.pathFor(id), { force: true })
  }

  private async read(path: string): Promise<CheckpointManifest> {
    return checkpointManifestSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  }

  private pathFor(id: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`无效检查点 ID：${id}`)
    return join(this.manifestDir, `${id}.json`)
  }
}

