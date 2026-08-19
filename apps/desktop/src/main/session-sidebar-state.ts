import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

interface StoredSessionSidebarState {
  version: 1
  pinnedSessionIds: string[]
}

/** 会话内容与侧栏排列是两种事实；置顶顺序使用独立、有界的宿主偏好。 */
export class SessionSidebarStateStore {
  private readonly path: string
  private pinnedSessionIds: string[] = []
  private writeTail: Promise<void> = Promise.resolve()

  constructor(path: string) {
    this.path = path
  }

  async initialize(validSessionIds: ReadonlySet<string>): Promise<void> {
    let stored: StoredSessionSidebarState | null = null
    try {
      stored = parseStoredState(JSON.parse(await readFile(this.path, 'utf8')))
    } catch {}
    this.pinnedSessionIds = (stored?.pinnedSessionIds ?? [])
      .filter((sessionId) => validSessionIds.has(sessionId))
  }

  orderedPinnedSessionIds(): readonly string[] {
    return this.pinnedSessionIds
  }

  setPinned(sessionId: string, pinned: boolean): Promise<void> {
    const write = this.writeTail.then(async () => {
      const current = this.pinnedSessionIds
      const exists = current.includes(sessionId)
      if (exists === pinned) return
      const next = pinned
        ? [...current, sessionId]
        : current.filter((candidate) => candidate !== sessionId)
      await writeStoredState(this.path, next)
      this.pinnedSessionIds = next
    })
    this.writeTail = write.catch(() => {})
    return write
  }
}

function parseStoredState(value: unknown): StoredSessionSidebarState | null {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.pinnedSessionIds)) {
    return null
  }
  if (!value.pinnedSessionIds.every((sessionId) => typeof sessionId === 'string')) return null
  return {
    version: 1,
    pinnedSessionIds: [...new Set(value.pinnedSessionIds)],
  }
}

async function writeStoredState(path: string, pinnedSessionIds: string[]): Promise<void> {
  const directory = dirname(path)
  const temporary = join(directory, `.session-sidebar-${randomUUID()}.tmp`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    await writeFile(temporary, `${JSON.stringify({
      version: 1,
      pinnedSessionIds,
    } satisfies StoredSessionSidebarState, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
      flush: true,
    })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
