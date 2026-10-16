import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserReferenceEditor } from '../browser-reference-editor.tsx'
import type { useBrowserReference } from '../use-browser-reference.ts'
import type { BrowserTargetCapture } from '../../../shared/browser-reference.ts'
import '../styles.css'

export { composeBrowserReference, restoreBrowserReference } from '../browser-reference-image.ts'

let root: ReturnType<typeof createRoot> | undefined

export function mountEditor(width = 680) {
  root ??= createRoot(document.getElementById('root')!)
  root.render(<EditorFixture width={width} />)
}

export function unmountEditor() {
  root?.unmount()
  root = undefined
}

function EditorFixture({ width }: { width: number }) {
  const [boundary, setBoundary] = useState<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(true)
  const [comment, setComment] = useState('调整这几个按钮')
  const [anchor] = useState({ x: 0.5, y: 0.3, width: 0.1, height: 0.1 })
  const [captures] = useState<BrowserTargetCapture[]>(() => Array.from({ length: 6 }, (_, index) => ({
    target: { id: crypto.randomUUID(), kind: 'element', label: `按钮 ${index + 1}`,
      rect: { x: 50, y: 50, width: 40, height: 30 },
      viewport: { width: 680, height: 550, scrollX: 0, scrollY: 0, zoom: 1 }, capturedAt: new Date().toISOString() },
    bytes: new Uint8Array(), page: { url: 'file:///fixture.html', title: '引用测试' },
    crop: { x: 0, y: 0, width: 160, height: 120 }, continuePicking: false,
  })))
  const reference: ReturnType<typeof useBrowserReference> = {
    mode: 'comment', editing: true, comment, setComment, anchor, captures,
    pick() {}, async save() {}, cancel() { setOpen(false) }, escape() { setOpen(false) },
    finishPicking() {}, remove() {}, toggle() {},
  }
  return <div ref={setBoundary} id="browser-boundary" style={{ position: 'absolute', left: 360, top: 100, width, height: 550 }}>
    {open && <BrowserReferenceEditor reference={reference} boundary={boundary} />}
  </div>
}
