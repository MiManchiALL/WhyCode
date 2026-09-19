import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { normalizeSessionName } from '../shared/session-name.ts'

interface StoredSessionSidebarState {
  version: 1
  pinnedSessionIds: string[]
  names: Record<string, string>
}

/** 手动名称与置顶属于宿主偏好，不改写会话历史、模型输入或活动时间。 */
export class SessionSidebarStateStore {
  private readonly path: string
  private state: StoredSessionSidebarState = { version: 1, pinnedSessionIds: [], names: {} }
  private writeTail: Promise<void> = Promise.resolve()

  constructor(path: string) {
    this.path = path
  }

  async initialize(validSessionIds: ReadonlySet<string>): Promise<void> {
    let stored: StoredSessionSidebarState | null = null
    try {
      stored = parseStoredState(JSON.parse(await readFile(this.path, 'utf8')))
    } catch {}
    if (stored) this.state = {
      ...stored,
      pinnedSessionIds: stored.pinnedSessionIds.filter(id => validSessionIds.has(id)),
      names: Object.fromEntries(Object.entries(stored.names).filter(([id]) => validSessionIds.has(id))),
    }
  }

  orderedPinnedSessionIds(): readonly string[] {
    return this.state.pinnedSessionIds
  }

  name(sessionId: string): string | undefined {
    return this.state.names[sessionId]
  }

  setName(sessionId: string, value: unknown): Promise<void> {
    const name = normalizeSessionName(value)
    return this.update(state => state.names[sessionId] === name ? state : {
      ...state, names: { ...state.names, [sessionId]: name },
    })
  }

  remove(sessionId: string): Promise<void> {
    return this.update(state => {
      const names = { ...state.names }
      delete names[sessionId]
      return { ...state, names, pinnedSessionIds: state.pinnedSessionIds.filter(id => id !== sessionId) }
    })
  }

  setPinned(sessionId: string, pinned: boolean): Promise<void> {
    return this.update(state => {
      const current = state.pinnedSessionIds
      const exists = current.includes(sessionId)
      if (exists === pinned) return state
      const pinnedSessionIds = pinned
        ? [...current, sessionId]
        : current.filter((candidate) => candidate !== sessionId)
      return { ...state, pinnedSessionIds }
    })
  }

  private update(transform: (state: StoredSessionSidebarState) => StoredSessionSidebarState): Promise<void> {
    const write = this.writeTail.then(async () => {
      const next = transform(this.state)
      if (next === this.state) return
      await writeStoredState(this.path, next)
      this.state = next
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
  const storedNames = value.names ?? {}
  if (!isRecord(storedNames)) return null
  const names = Object.fromEntries(Object.entries(storedNames).map(([id, name]) => [id, normalizeSessionName(name)]))
  return {
    version: 1,
    pinnedSessionIds: [...new Set(value.pinnedSessionIds)],
    names,
  }
}

async function writeStoredState(path: string, state: StoredSessionSidebarState): Promise<void> {
  const directory = dirname(path)
  const temporary = join(directory, `.session-sidebar-${randomUUID()}.tmp`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
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
