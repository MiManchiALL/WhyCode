import type { WhycodeApi } from '../../preload/index.ts'
import type { OpenWorkspaceFileRequest, WorkspaceFileView } from '../../shared/workspace-files.ts'

type FileApi = Pick<WhycodeApi, 'openWorkspaceFile' | 'readWorkspaceFile' | 'closeWorkspaceFile' | 'onWorkspaceFileChanged'>
interface FileState {
  view: WorkspaceFileView | null
  loading: boolean
  changed: boolean
  error: string | null
}
interface Lease { id: string | null; revision: number; unsubscribe: () => void }
const initialState = (): FileState => ({ view: null, loading: true, changed: false, error: null })

/** 文件由预览持有，目录由所属标签持有；读取、变化通知与取消共用一个生命周期。 */
export class WorkspaceFileResource {
  private state = initialState()
  private lease: Lease | null = null
  private pending: Promise<boolean> | null = null
  private automatic = true
  private readonly listeners = new Set<() => void>()
  private readonly api: FileApi
  private readonly request: OpenWorkspaceFileRequest

  constructor(api: FileApi, request: OpenWorkspaceFileRequest) { this.api = api; this.request = request }

  getSnapshot = (): FileState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  open(): void { if (!this.lease) void this.refresh() }

  setAutomatic(enabled: boolean): void {
    this.automatic = enabled
    if (enabled && this.state.changed) void this.refresh()
  }

  invalidate(): void {
    if (!this.lease) return
    this.lease.revision++
    this.publish({ ...this.state, changed: true })
    if (this.request.kind === 'directory' && this.automatic) void this.refresh()
  }

  refresh = (offset = 0): Promise<boolean> => {
    if (this.pending) return this.pending
    let current = this.lease
    if (!current) {
      const opened: Lease = { id: null, revision: 0, unsubscribe: () => {} }
      current = opened
      this.lease = opened
      opened.unsubscribe = this.api.onWorkspaceFileChanged(change => {
        if (this.lease === opened && opened.id === change.id) this.invalidate()
      })
    }
    const reading = current
    const revision = current.revision
    this.publish({ ...this.state, loading: true, error: null })
    this.pending = this.read(reading, offset).then(view => {
      if (this.lease !== reading || !view) return false
      // 先结束当前读取，再通知界面；订阅者可能立即请求恢复下一页。
      this.pending = null
      this.publish({ view, loading: false, changed: reading.revision !== revision, error: null })
      if (this.request.kind === 'directory' && this.automatic && this.state.changed) {
        void this.refresh()
      }
      return true
    }, error => {
      if (this.lease === reading) {
        this.pending = null
        this.publish({ ...this.state, loading: false, error: error instanceof Error ? error.message : String(error) })
      }
      return false
    })
    return this.pending
  }

  close(): void {
    const current = this.lease
    this.lease = null
    this.pending = null
    current?.unsubscribe()
    if (current?.id) this.api.closeWorkspaceFile(current.id)
    this.publish(initialState())
  }

  private async read(current: Lease, offset: number): Promise<WorkspaceFileView | null> {
    const previous = this.state.view
    const opening = current.id === null
    const result = opening
      ? await this.api.openWorkspaceFile(this.request)
      : await this.api.readWorkspaceFile({ id: current.id!, offset })
    if (!result.ok) throw new Error(result.error)
    if (this.lease !== current) {
      if (opening) this.api.closeWorkspaceFile(result.view.id)
      return null
    }
    current.id = result.view.id
    let view = result.view
    if (view.kind === 'directory' && previous?.kind === 'directory') {
      if (offset > 0) view = { ...view, entries: [...previous.entries, ...view.entries] }
      // 刷新完整替换已浏览的分页，避免第一批结果截短列表并把阅读位置拉回顶部。
      while (offset === 0 && view.entries.length < Math.min(view.total, previous.entries.length)) {
        const page = await this.api.readWorkspaceFile({ id: current.id, offset: view.entries.length })
        if (this.lease !== current) return null
        if (!page.ok) throw new Error(page.error)
        if (page.view.kind !== 'directory') throw new Error('目录读取结果无效')
        view = { ...page.view, entries: [...view.entries, ...page.view.entries] }
      }
    }
    return view
  }

  private publish(state: FileState): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }
}
