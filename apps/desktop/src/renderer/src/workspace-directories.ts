import { WorkspaceFileResource } from './workspace-file-resource.ts'

/** 只保留当前会话目录标签的已展开层级，标签切换不释放列表或监听。 */
export class WorkspaceDirectories {
  private readonly levels = new Map<string, WorkspaceFileResource>()
  private active = false
  private readonly api: ConstructorParameters<typeof WorkspaceFileResource>[0]
  private readonly runtimeId: string
  private revision: string

  constructor(api: ConstructorParameters<typeof WorkspaceFileResource>[0], runtimeId: string, revision: string) {
    this.api = api; this.runtimeId = runtimeId; this.revision = revision
  }

  get(path: string): WorkspaceFileResource {
    let level = this.levels.get(path)
    if (!level) {
      level = new WorkspaceFileResource(this.api, { runtimeId: this.runtimeId, kind: 'directory', path })
      level.setAutomatic(this.active)
      this.levels.set(path, level)
      const current = level
      level.subscribe(() => {
        const state = current.getSnapshot()
        if (this.levels.get(path) !== current || state.loading || state.error || state.view?.kind !== 'directory') return
        const children = new Set(state.view.entries.filter(entry => entry.kind === 'directory').map(entry => entry.path))
        for (const child of this.levels.keys()) {
          if (child && child.slice(0, Math.max(0, child.lastIndexOf('/'))) === path && !children.has(child)) this.remove(child)
        }
      })
    }
    return level
  }

  retain(expanded: readonly string[]): void {
    for (const [path, level] of this.levels) {
      if (path !== '' && !expanded.includes(path)) { this.levels.delete(path); level.close() }
    }
  }

  setActive(active: boolean, remote: boolean): void {
    if (this.active === active) return
    this.active = active
    for (const level of this.levels.values()) {
      // SSH 没有目录监听，切回时保留列表并在后台核对外部改动。
      if (active && remote && level.getSnapshot().view) level.invalidate()
      level.setAutomatic(active)
    }
  }

  invalidate(): void { for (const level of this.levels.values()) level.invalidate() }
  setRevision(revision: string): void {
    if (revision === this.revision) return
    this.revision = revision
    this.invalidate()
  }
  refresh(): void { for (const level of this.levels.values()) void level.refresh() }
  close(): void {
    for (const level of this.levels.values()) level.close()
  }

  private remove(path: string): void {
    for (const [child, level] of this.levels) {
      if (child === path || child.startsWith(`${path}/`)) { this.levels.delete(child); level.close() }
    }
  }
}
