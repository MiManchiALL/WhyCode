import { useEffect, useRef, useState } from 'react'
import { BROWSER_REFERENCE_MAX_TARGETS } from '@whycode/core/browser-reference'
import type { BrowserReferenceImage, BrowserReferenceProjection, BrowserTargetCapture } from '../../shared/browser-reference.ts'
import type { BrowserReferenceRequest } from './right-panel-state.ts'
import type { ImageDraft } from './image-draft.ts'
import { composeBrowserReference, restoreBrowserReference, sameBrowserTarget } from './browser-reference-image.ts'
import { useConversationFeedback } from './conversation-feedback.tsx'

interface Props {
  leaseId?: string
  pageId: string
  active: boolean
  available: boolean
  url: string
  loading: boolean
  request?: BrowserReferenceRequest
  drafts: readonly ImageDraft[]
  onRequestHandled: () => void
  onAdd: (image: BrowserReferenceImage, replaceId?: string) => boolean
  focusPage: () => void
}

export function useBrowserReference(props: Props) {
  const [mode, setMode] = useState<'off' | 'picking' | 'comment' | 'saving' | 'restoring'>('off')
  const [captures, setCaptures] = useState<BrowserTargetCapture[]>([])
  const [comment, setComment] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<BrowserReferenceProjection['anchor']>()
  const generation = useRef(0)
  const latest = useRef(props); latest.current = props
  const feedback = useConversationFeedback()
  const cancel = () => {
    generation.current++
    if (latest.current.leaseId) window.whycode.cancelBrowserReference(latest.current.leaseId)
    setMode('off'); setCaptures([]); setComment(''); setEditingId(null); setAnchor(undefined)
  }
  useEffect(() => {
    cancel()
    return () => { generation.current++; if (props.leaseId) window.whycode.cancelBrowserReference(props.leaseId) }
  }, [props.active, props.leaseId, props.url, props.loading, props.available])
  useEffect(() => {
    if (editingId && !props.drafts.some(draft => draft.id === editingId)) cancel()
  }, [props.drafts, editingId])
  useEffect(() => {
    if (!props.request || !props.active || !props.available || !props.leaseId || props.loading) return
    const request = props.request
    props.onRequestHandled()
    cancel()
    if (request.kind === 'new') { pick([]); return }
    const draft = props.drafts.find(item => item.id === request.draftId)
    if (!draft?.source) return
    const revision = ++generation.current
    setMode('restoring')
    void restoreBrowserReference(draft.previewUrl, draft.source).then(restored => {
      if (revision !== generation.current) return
      setEditingId(draft.id); setComment(draft.source!.comment); setCaptures(restored)
      display(restored, true)
    }).catch(error => { if (revision === generation.current) { feedback('error', String(error)); cancel() } })
  }, [props.request, props.active, props.available, props.leaseId, props.loading])

  const display = (selected: BrowserTargetCapture[], reveal = false) => {
    if (!selected.length) { pick([]); return }
    const id = latest.current.leaseId
    if (!id) return
    const revision = ++generation.current
    void window.whycode.displayBrowserReference(id, { selected: selected.map(item => item.target), reveal }).then(result => {
      if (revision !== generation.current || !result) return
      setAnchor(result.anchor); setMode('comment')
      if (result.missing.length) feedback('info', `${result.missing.length} 个目标在当前页面中已无法定位，原截图仍保留，可移除或重新选择`)
    }).catch(error => { if (revision === generation.current) { setMode('comment'); feedback('error', String(error)) } })
  }
  const pick = (selected = captures, parent = false) => {
    const id = latest.current.leaseId
    if (!id || !latest.current.active || !latest.current.available) return
    const revision = ++generation.current
    setMode('picking'); latest.current.focusPage()
    void window.whycode.pickBrowserTarget(id, { selected: selected.map(item => item.target), parent }).then(result => {
      if (revision !== generation.current) return
      if (!result) { cancel(); return }
      const base = parent ? selected.slice(0, -1) : selected
      const duplicate = base.findIndex(item => sameBrowserTarget(item, result))
      const next = duplicate >= 0 ? (parent ? base : base.filter((_, index) => index !== duplicate)) : [...base, result]
      if (next.length > BROWSER_REFERENCE_MAX_TARGETS) {
        feedback('info', `每条引用最多选择 ${BROWSER_REFERENCE_MAX_TARGETS} 个目标，可分成多条引用`)
        display(selected); return
      }
      setCaptures(next)
      if (!parent && duplicate >= 0 || result.continuePicking && next.length < BROWSER_REFERENCE_MAX_TARGETS) pick(next)
      else display(next)
    }).catch(error => {
      if (revision !== generation.current) return
      feedback('error', String(error))
      if (selected.length) display(selected)
      else cancel()
    })
  }
  const save = async () => {
    if (!comment.trim() || !captures.length || mode === 'saving') return
    const revision = ++generation.current
    setMode('saving')
    try {
      const image = await composeBrowserReference(captures, comment)
      if (revision !== generation.current) return
      if (!latest.current.onAdd({ ...image, browserId: latest.current.pageId }, editingId ?? undefined)) { setMode('comment'); return }
      setCaptures([]); setComment(''); setEditingId(null); pick([])
      feedback('success', editingId ? '网页引用已更新' : '网页引用已加入对话')
    } catch (error) { if (revision === generation.current) { setMode('comment'); feedback('error', String(error)) } }
  }
  const escape = () => {
    if (editingId || mode === 'restoring') { cancel(); return }
    if (captures.length) { setCaptures([]); setComment(''); pick([]) }
    else cancel()
  }
  return { mode, captures, comment, setComment, anchor, editing: editingId !== null, pick, save, cancel, escape,
    finishPicking: () => display(captures),
    remove: (index: number) => { const next = captures.filter((_, i) => i !== index); setCaptures(next); display(next) },
    toggle: () => mode === 'off' ? pick([]) : cancel() }
}
