import { useEffect, useRef, useState } from 'react'
import { BROWSER_REFERENCE_MAX_TARGETS } from '@whycode/core/browser-reference'
import type { BrowserReferenceImage, BrowserTargetCapture } from '../../shared/browser-reference.ts'
import { composeBrowserReference, sameBrowserTarget } from './browser-reference-image.ts'
import { useConversationFeedback } from './conversation-feedback.tsx'

interface Props {
  leaseId?: string
  active: boolean
  available: boolean
  url: string
  loading: boolean
  autoStart: boolean
  onAutoStarted: () => void
  onAdd: (image: BrowserReferenceImage) => boolean
  focusPage: () => void
}

export function useBrowserReference(props: Props) {
  const [mode, setMode] = useState<'off' | 'picking' | 'comment' | 'saving'>('off')
  const [captures, setCaptures] = useState<BrowserTargetCapture[]>([])
  const [comment, setComment] = useState('')
  const generation = useRef(0)
  const latest = useRef(props); latest.current = props
  const feedback = useConversationFeedback()
  const cancel = () => {
    generation.current++
    if (latest.current.leaseId) window.whycode.cancelBrowserReference(latest.current.leaseId)
    setMode('off'); setCaptures([]); setComment('')
  }
  useEffect(() => {
    cancel()
    return () => { generation.current++; if (props.leaseId) window.whycode.cancelBrowserReference(props.leaseId) }
  }, [props.active, props.leaseId, props.url, props.loading, props.available])
  useEffect(() => {
    if (props.autoStart && props.active && props.available && props.leaseId && !props.loading) {
      props.onAutoStarted(); pick([])
    }
  }, [props.autoStart, props.active, props.available, props.leaseId, props.loading])

  const pick = (selected = captures, parent = false) => {
    const id = latest.current.leaseId
    if (!id || !latest.current.active || !latest.current.available) return
    const request = ++generation.current
    setMode('picking'); latest.current.focusPage()
    void window.whycode.pickBrowserTarget(id, { selected: selected.map(item => item.target), parent }).then(result => {
      if (request !== generation.current) return
      if (!result) {
        if (selected.length) { setCaptures([]); setComment(''); pick([]) }
        else cancel()
        return
      }
      const base = parent ? selected.slice(0, -1) : selected
      const duplicate = base.findIndex(item => sameBrowserTarget(item, result))
      const next = duplicate >= 0 ? (parent ? base : base.filter((_, index) => index !== duplicate)) : [...base, result]
      if (next.length > BROWSER_REFERENCE_MAX_TARGETS) {
        feedback('info', `每条引用最多选择 ${BROWSER_REFERENCE_MAX_TARGETS} 个目标，可分成多条引用`)
        setMode('comment'); return
      }
      setCaptures(next)
      if (!parent && duplicate >= 0 || result.continuePicking && next.length < BROWSER_REFERENCE_MAX_TARGETS) pick(next)
      else setMode('comment')
    }).catch(error => {
      if (request === generation.current) {
        feedback('error', String(error))
        if (selected.length) { window.whycode.cancelBrowserReference(id); setMode('comment') }
        else cancel()
      }
    })
  }
  const save = async () => {
    if (!comment.trim() || !captures.length || mode === 'saving') return
    const request = ++generation.current
    setMode('saving')
    try {
      const image = await composeBrowserReference(captures, comment)
      if (request !== generation.current) return
      if (!latest.current.onAdd(image)) { setMode('comment'); return }
      setCaptures([]); setComment(''); pick([])
      feedback('success', '网页引用已加入对话')
    } catch (error) { if (request === generation.current) { setMode('comment'); feedback('error', String(error)) } }
  }
  const escape = () => {
    if (captures.length) { setCaptures([]); setComment(''); pick([]) }
    else cancel()
  }
  const finishPicking = () => {
    if (!captures.length) return
    generation.current++
    if (props.leaseId) window.whycode.cancelBrowserReference(props.leaseId)
    setMode('comment')
  }
  return { mode, captures, comment, setComment, pick, save, cancel, escape,
    finishPicking,
    remove: (index: number) => { const next = captures.filter((_, i) => i !== index); setCaptures(next); pick(next) },
    toggle: () => mode === 'off' ? pick([]) : cancel() }
}
