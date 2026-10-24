import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import {
  $addUpdateTag, $getSelection, $isRangeSelection, $setSelection,
  CLEAR_HISTORY_COMMAND, COMMAND_PRIORITY_HIGH, COPY_COMMAND, CUT_COMMAND, DROP_COMMAND,
  KEY_DOWN_COMMAND, PASTE_COMMAND, PASTE_TAG, SKIP_DOM_SELECTION_TAG,
} from 'lexical'
import { PathReferenceNode } from './path-reference-node.ts'
import { $appendPathReference, $composerCursor, $composerNodes, $composerSelectionText, $composerText, $replaceComposerText, $selectComposerOffset } from './composer-input-state.ts'
import { readWorkspacePathDrag, WORKSPACE_PATH_MIME, type PathReference } from './path-reference.ts'
import { useConversationFeedback } from './conversation-feedback.tsx'

export interface ComposerInputHandle {
  focus: () => void
  setCursor: (offset: number) => void
  appendReference: (reference: PathReference) => void
}

interface ComposerInputProps {
  ref?: Ref<ComposerInputHandle>
  scopeKey: string
  runtimeId: string
  value: string
  disabled?: boolean
  className?: string
  placeholder?: string
  'aria-label'?: string
  'aria-controls'?: string
  'aria-activedescendant'?: string
  onChange: (text: string, cursor: number | null) => void
  onSelect?: (cursor: number | null) => void
  onBlur?: () => void
  onPaste?: (event: ClipboardEvent) => void
  onKeyDown: (event: KeyboardEvent) => void
}

export function ComposerInput(props: ComposerInputProps) {
  return <LexicalComposer initialConfig={{
    namespace: 'whycode-composer', nodes: [PathReferenceNode], editable: !props.disabled,
    editorState: () => $replaceComposerText(props.value), onError: error => { throw error },
  }}>
    <InputEditor {...props} />
    <HistoryPlugin />
  </LexicalComposer>
}

const EXTERNAL_VALUE = 'composer-external-value'

function InputEditor(props: ComposerInputProps) {
  const [editor] = useLexicalComposerContext()
  const latest = useRef(props)
  latest.current = props
  const scope = useRef(props.scopeKey)
  const [dragging, setDragging] = useState(false)
  const feedback = useConversationFeedback()

  useLayoutEffect(() => {
    editor.setEditable(!props.disabled)
  }, [editor, props.disabled])

  useLayoutEffect(() => {
    const changedScope = scope.current !== props.scopeKey
    scope.current = props.scopeKey
    if (!changedScope && editor.getEditorState().read($composerText) === props.value) return
    editor.update(() => {
      $replaceComposerText(props.value)
      $setSelection(null)
    }, { tag: [EXTERNAL_VALUE, SKIP_DOM_SELECTION_TAG], discrete: true })
    // 已提交消息和其它会话的草稿不能通过撤销回到当前编辑器。
    editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined)
    setDragging(false)
  }, [editor, props.value, props.scopeKey])

  useImperativeHandle(props.ref, () => ({
    focus: () => editor.focus(),
    setCursor: offset => editor.update(() => $selectComposerOffset(offset)),
    appendReference: reference => {
      if (latest.current.disabled) return
      editor.update(() => $appendPathReference(reference))
      editor.focus()
    },
  }), [editor])

  useEffect(() => editor.registerUpdateListener(({ editorState, tags }) => {
    if (tags.has(EXTERNAL_VALUE) || scope.current !== latest.current.scopeKey) return
    editorState.read(() => {
      const text = $composerText()
      const cursor = $composerCursor()
      if (text !== latest.current.value) latest.current.onChange(text, cursor)
      else latest.current.onSelect?.(cursor)
    })
  }), [editor])

  useEffect(() => {
    const releases = [
      editor.registerCommand(KEY_DOWN_COMMAND, event => {
        // 组字确认交给输入法，不能再由纯文本插件解释为换行。
        if (event.isComposing || editor.isComposing()) return true
        latest.current.onKeyDown(event)
        return event.defaultPrevented
      }, COMMAND_PRIORITY_HIGH),
      editor.registerCommand(PASTE_COMMAND, event => {
        if (!('clipboardData' in event) || !event.clipboardData) return false
        latest.current.onPaste?.(event)
        if (event.defaultPrevented) return true
        const selection = $getSelection()
        if (!$isRangeSelection(selection)) return false
        event.preventDefault()
        const text = event.clipboardData.getData('text/plain')
        if (!text) return true
        $addUpdateTag(PASTE_TAG)
        selection.insertNodes($composerNodes(text))
        return true
      }, COMMAND_PRIORITY_HIGH),
      ...[COPY_COMMAND, CUT_COMMAND].map(command => editor.registerCommand(command, event => {
        const selection = $getSelection()
        if (!event || !('clipboardData' in event) || !event.clipboardData || !$isRangeSelection(selection)) return false
        event.preventDefault()
        event.clipboardData.setData('text/plain', $composerSelectionText(selection))
        if (command === CUT_COMMAND) selection.removeText()
        return true
      }, COMMAND_PRIORITY_HIGH)),
      editor.registerCommand(DROP_COMMAND, event => {
        setDragging(false)
        if (!event.dataTransfer?.types.includes(WORKSPACE_PATH_MIME)) {
          // 系统文件继续交给已有图片/PDF 附件入口，禁止编辑器插入文件名。
          return Boolean(event.dataTransfer?.types.includes('Files'))
        }
        event.preventDefault()
        event.stopPropagation()
        if (latest.current.disabled) return true
        const reference = readWorkspacePathDrag(event.dataTransfer, latest.current.runtimeId)
        if (!reference) { feedback('error', '请在该路径所属的会话中引用'); return true }
        $appendPathReference(reference)
        editor.focus()
        return true
      }, COMMAND_PRIORITY_HIGH),
    ]
    return () => { for (const release of releases) release() }
  }, [editor, feedback])

  return <div className="wc-composer-input relative min-w-0" data-path-dragging={dragging || undefined}
    onDragOver={event => {
      if (!event.dataTransfer.types.includes(WORKSPACE_PATH_MIME)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = props.disabled ? 'none' : 'copy'
      setDragging(!props.disabled)
    }}
    onDragLeave={event => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false)
    }}
    onDragEnd={() => setDragging(false)}>
    <PlainTextPlugin
      contentEditable={<ContentEditable
        className={`wc-composer-editor ${props.className ?? ''}`}
        aria-label={props['aria-label'] ?? '输入消息'}
        aria-controls={props['aria-controls']}
        aria-activedescendant={props['aria-activedescendant']}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-placeholder={props.placeholder ?? ''}
        placeholder={<div className="wc-composer-placeholder pointer-events-none absolute inset-0 text-[var(--wc-faint)]" aria-hidden="true">{props.placeholder}</div>}
        onBlur={props.onBlur}
      />}
      ErrorBoundary={LexicalErrorBoundary}
    />
    {dragging && <span className="pointer-events-none absolute right-2 bottom-1 text-xs text-[var(--wc-sage-ink)]">松开以引用路径</span>}
  </div>
}
