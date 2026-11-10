import { useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { CodeReviewSurface } from '../code-review.tsx'
import { CodeReferenceChips } from '../code-reference-chips.tsx'
import { codePreviewVersion, codeReferenceMessage, ComposerCodeReferences, retainedCodeComments } from '../code-reference.ts'
import { ComposerDraftStore, type ComposerDraft } from '../composer-drafts.ts'
import { DocumentPreview } from '../document-preview.tsx'
import { FileDiff } from '../file-diff.tsx'
import { ConversationFeedbackContext } from '../conversation-feedback.tsx'
import { MarkdownFileLink } from '../markdown-elements.ts'
import { activeRightPanelPage, closeRightPanelTab, openRightPanelPage, RightPanelSessionStore, updateRightPanelPage, type RightPanelPage } from '../right-panel-state.ts'
import '../styles.css'

const workspace = '/project'
const path = workspace + '/sample.ts'
const samples = Array.from({ length: 110 }, (_, i) => `const value${i + 1} = ${i + 1};`)
samples.splice(63, 3, 'const first = 1;', '  const second = 42;', '  return second + 1;')
const url = URL.createObjectURL(new Blob([samples.join('\n')], { type: 'text/plain' }))
Object.assign(window, { whycode: {
  onWorkspaceFileChanged: () => () => {}, closeWorkspaceFile() {},
  openWorkspaceFile: async () => ({ ok: true, view: { id: 'file', kind: 'file', path, name: 'sample.ts', format: 'code', url, size: 3000, mediaType: 'text/plain' } }),
} })
const references = new ComposerCodeReferences()
const drafts = new ComposerDraftStore()
const key = 'code-review-fixture'
const draft: ComposerDraft = { text: '', images: [], pdfs: [], skills: [], restoredInputIds: [], btwMode: null }
await drafts.load(key)
references.replace(drafts.take(key)?.codeReferences ?? [])

function Fixture() {
  const [state, setState] = useState(() => new RightPanelSessionStore(null).get(key))
  const items = useSyncExternalStore(references.subscribe, references.getSnapshot)
  const page = activeRightPanelPage(state)
  const version = codePreviewVersion(page)
  const open = (next: RightPanelPage) => setState(current => openRightPanelPage(current, next))
  const [message, setMessage] = useState('')
  return <div className="grid h-screen grid-cols-[minmax(240px,1fr)_minmax(320px,1.3fr)]">
    <main className="space-y-4 p-5">
      <MarkdownFileLink path={path} projectDir={workspace} line={64} endLine={66} onOpenFile={open}>样例代码</MarkdownFileLink>
      <p id="prose">正文可单独选择。</p>
      <button id="outside" onMouseDown={e => e.preventDefault()}>其它区域</button>
      <div className="wc-composer-chips"><CodeReferenceChips items={items} onRemove={references.remove} /></div>
      <button id="submit" onClick={() => {
        setMessage(codeReferenceMessage('请核对', items))
        references.replace(retainedCodeComments(items))
      }}>提交样例</button>
      <output id="message" className="block max-h-40 overflow-auto whitespace-pre-wrap">{message}</output>
      <button id="save" onClick={async e => {
        const button = e.currentTarget
        await drafts.save(key, { ...draft, codeReferences: references.getSnapshot() })
        button.dataset.saved = 'true'
      }}>保存草稿</button>
    </main>
    <aside className="flex min-h-0 flex-col border-l border-[var(--wc-line)]">
      <div className="flex h-10 items-center gap-4 p-2"><span>文件预览</span>
        <button id="close" onClick={() => state.activeTabId && setState(closeRightPanelTab(state, state.activeTabId))}>关闭标签</button>
        <button id="reopen" onClick={() => open({ kind: 'file', path, name: 'sample.ts', source: { kind: 'current' } })}>打开文件</button>
        <button id="diff" onClick={() => open({ kind: 'changes', checkpointIds: ['example'], expandedPaths: [], selectedPath: path })}>差异</button>
        <span id="tab-count">{state.tabs.length}</span></div>
      <CodeReviewSurface review={version ? { workspace, version, items, disabled: false,
        add: item => references.add(item), remove: references.remove } : null}>
        {page?.kind === 'file' && <DocumentPreview runtimeId="test" page={page} onChange={next => setState(current => updateRightPanelPage(current, next))} />}
        {page?.kind === 'changes' && <FileDiff path={path} preview={{ path,
          before: { kind: 'text', content: 'head\nold value\ntail', size: 19 }, after: { kind: 'text', content: 'head\nnew value\ntail', size: 19 } }} />}
      </CodeReviewSurface>
    </aside>
  </div>
}
createRoot(document.getElementById('root')!).render(<ConversationFeedbackContext value={(_tone, message) => { throw new Error(message) }}>
  <Fixture />
</ConversationFeedbackContext>)
