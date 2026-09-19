import type { BtwMode } from '@whycode/core'
import type { SkillSummary } from '@whycode/core/skills'
import { releaseImageDrafts, type ImageDraft } from './image-draft.ts'
import type { PdfDraft } from './pdf-draft.ts'

export interface ComposerDraft {
  text: string
  images: ImageDraft[]
  pdfs: PdfDraft[]
  skills: SkillSummary[]
  btwMode: BtwMode | null
  restoredInputIds: string[]
}

type StoredImage = ImageDraft extends infer T
  ? T extends ImageDraft ? Omit<T, 'previewUrl' | 'file'> : never : never
interface StoredDraft extends Omit<ComposerDraft, 'images'> { images: StoredImage[] }

export function composerDraftKey(runtimeId: string, sessionId: string | null): string {
  return sessionId ?? `draft:${runtimeId}`
}

function hasContent(draft: ComposerDraft): boolean {
  return Boolean(draft.text || draft.images.length || draft.pdfs.length || draft.skills.length || draft.btwMode)
}

/** IndexedDB 持有持久草稿与 File；内存仅缓存最近切走的 32 份预览，淘汰不删除草稿。 */
export class ComposerDraftStore {
  private database: Promise<IDBDatabase> | null = null
  private readonly cached = new Map<string, ComposerDraft>()
  private readonly loading = new Map<string, { promise: Promise<void>; valid: boolean }>()

  private open(): Promise<IDBDatabase> {
    if (!this.database) {
      this.database = new Promise((resolve, reject) => {
        const request = indexedDB.open('whycode-composer', 1)
        request.onupgradeneeded = () => {
          request.result.createObjectStore('drafts')
          request.result.createObjectStore('images')
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    }
    return this.database
  }

  get(key: string): ComposerDraft | undefined { return this.cached.get(key) }

  cache(key: string, draft: ComposerDraft): void {
    this.invalidate(key)
    const previous = this.cached.get(key)
    if (previous && previous !== draft) releaseImageDrafts(previous.images)
    this.cached.delete(key)
    if (hasContent(draft)) this.cached.set(key, draft)
    else releaseImageDrafts(draft.images)
    while (this.cached.size > 32) {
      const oldest = this.cached.keys().next().value!
      releaseImageDrafts(this.cached.get(oldest)!.images)
      this.cached.delete(oldest)
    }
  }

  take(key: string): ComposerDraft | undefined {
    this.invalidate(key)
    const draft = this.cached.get(key)
    this.cached.delete(key)
    return draft
  }

  load(key: string): Promise<void> {
    if (this.cached.has(key)) return Promise.resolve()
    const pending = this.loading.get(key)
    if (pending) return pending.promise
    const request = { promise: Promise.resolve(), valid: true }
    const loading = this.read(key).then((loaded) => {
      if (!loaded || !request.valid || this.cached.has(key)) return
      this.cache(key, {
        ...loaded.stored,
        images: loaded.stored.images.map((image): ImageDraft => image.kind === 'stored'
          ? { ...image, previewUrl: `whycode-attachment://${image.sessionId}/${encodeURIComponent(image.storageName)}` }
          : { ...image, file: loaded.files.get(image.id)!, previewUrl: URL.createObjectURL(loaded.files.get(image.id)!) }),
      })
    }).finally(() => { if (this.loading.get(key) === request) this.loading.delete(key) })
    request.promise = loading
    this.loading.set(key, request)
    return loading
  }

  private async read(key: string): Promise<{ stored: StoredDraft; files: Map<string, File> } | undefined> {
    const database = await this.open()
    const transaction = database.transaction(['drafts', 'images'])
    let stored: StoredDraft | undefined
    const files = new Map<string, File>()
    const request = transaction.objectStore('drafts').get(key)
    request.onsuccess = () => {
      stored = request.result
      for (const image of stored?.images ?? []) {
        if (image.kind === 'stored') continue
        const file = transaction.objectStore('images').get([key, image.id])
        file.onsuccess = () => { if (file.result instanceof File) files.set(image.id, file.result) }
      }
    }
    await completed(transaction)
    if (!stored) return undefined
    if (stored.images.some((image) => image.kind !== 'stored' && !files.has(image.id))) {
      throw new Error('草稿图片数据不完整')
    }
    return { stored, files }
  }

  save(key: string, draft: ComposerDraft): Promise<void> {
    return this.write(key, hasContent(draft) ? draft : null)
  }

  delete(key: string): Promise<void> {
    const draft = this.take(key)
    if (draft) releaseImageDrafts(draft.images)
    return this.write(key, null)
  }

  private async write(key: string, draft: ComposerDraft | null): Promise<void> {
    const database = await this.open()
    const transaction = database.transaction(['drafts', 'images'], 'readwrite', { durability: 'strict' })
    const drafts = transaction.objectStore('drafts')
    const images = transaction.objectStore('images')
    const request = drafts.get(key)
    request.onsuccess = () => {
      const previous: StoredDraft | undefined = request.result
      const known = new Set(previous?.images.map((image) => image.id))
      const retained = new Set(draft?.images.map((image) => image.id))
      for (const image of previous?.images ?? []) {
        if (image.kind !== 'stored' && !retained.has(image.id)) images.delete([key, image.id])
      }
      if (!draft) { drafts.delete(key); return }
      const stored: StoredDraft = {
        ...draft,
        images: draft.images.map((image) => {
          const { previewUrl: _preview, ...descriptor } = image
          if (descriptor.kind === 'stored') return descriptor
          const { file, ...metadata } = descriptor
          // 文本变化只写元数据；附件的二进制在首次添加时写入，移除时一并删除。
          if (!known.has(image.id)) images.put(file, [key, image.id])
          return metadata
        }),
      }
      drafts.put(stored, key)
    }
    await completed(transaction)
  }

  /** 首次发送登记后原子转移草稿与附件，提交期间继续输入的内容仍属于该会话。 */
  async moveToSession(runtimeId: string, sessionId: string): Promise<void> {
    const sourceKey = composerDraftKey(runtimeId, null)
    const cached = this.take(sourceKey)
    if (cached) this.cache(sessionId, cached)
    this.invalidate(sessionId)
    const database = await this.open()
    const transaction = database.transaction(['drafts', 'images'], 'readwrite', { durability: 'strict' })
    const store = transaction.objectStore('drafts')
    const images = transaction.objectStore('images')
    const request = store.get(sourceKey)
    request.onsuccess = () => {
      const stored: StoredDraft | undefined = request.result
      if (!stored) return
      store.put(stored, sessionId)
      store.delete(sourceKey)
      for (const image of stored.images) {
        if (image.kind === 'stored') continue
        const file = images.get([sourceKey, image.id])
        file.onsuccess = () => {
          if (file.result) images.put(file.result, [sessionId, image.id])
          images.delete([sourceKey, image.id])
        }
      }
    }
    await completed(transaction)
  }

  async flush(): Promise<void> {
    if (!this.database) return
    const database = await this.open()
    await completed(database.transaction(['drafts', 'images'], 'readwrite', { durability: 'strict' }))
  }

  private invalidate(key: string): void {
    const request = this.loading.get(key)
    if (request) request.valid = false
  }

  dispose(): void {
    for (const request of this.loading.values()) request.valid = false
    this.loading.clear()
    for (const draft of this.cached.values()) releaseImageDrafts(draft.images)
    this.cached.clear()
    void this.database?.then((database) => database.close()).catch(() => {})
    this.database = null
  }
}

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('草稿保存事务已取消'))
    transaction.onerror = () => reject(transaction.error)
  })
}
