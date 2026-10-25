import { useContext, useMemo, useRef, useState, type ComponentProps } from 'react'
import { CodeBlockDownloadButton, StreamdownContext, useIsCodeFenceIncomplete, type ExtraProps } from 'streamdown'
import { Download, WrapText } from 'lucide-react'
import { CopyButton } from './message-actions.tsx'
import { useHighlightedCode } from './syntax-code.tsx'
import { escapeCodeHtml } from './syntax-code-html.ts'
import { useRenderVisibility } from './use-render-visibility.ts'
import { MermaidDiagram } from './mermaid-diagram.tsx'
import { MarkdownMessageIdContext, MarkdownViewOwnerContext } from './markdown-view-state.ts'

/** 只替换块级代码；行内代码、Markdown 解析与净化仍由 Streamdown 持有。 */
export function MarkdownCodeBlock({ node, children, ...props }: ComponentProps<'pre'> & ExtraProps) {
  const messageId = useContext(MarkdownMessageIdContext)
  const codeNode = node?.children[0]
  if (codeNode?.type !== 'element' || codeNode.tagName !== 'code') return <pre {...props}>{children}</pre>
  const code = codeNode.children.map(child => child.type === 'text' ? child.value : '').join('').replace(/\n$/u, '')
  const classes = codeNode.properties.className
  const language = (Array.isArray(classes) ? classes : []).find(value => typeof value === 'string' && value.startsWith('language-'))?.toString().slice(9) ?? ''
  const offset = node?.position?.start.offset
  const viewId = messageId !== null && offset !== undefined ? `${messageId}:${offset}` : undefined
  return <CodeFence code={code} language={language} viewId={viewId} />
}

function CodeFence({ code, language, viewId }: { code: string; language: string; viewId?: string }) {
  const owner = useContext(MarkdownViewOwnerContext)
  const ref = useRef<HTMLDivElement>(null)
  const visible = useRenderVisibility(ref)
  const incomplete = useIsCodeFenceIncomplete()
  const { isAnimating } = useContext(StreamdownContext)
  const streaming = incomplete || isAnimating
  const mermaid = /^(mermaid|mmd)$/iu.test(language)
  const [wrap, setWrap] = useState(false)
  const highlighted = useHighlightedCode(language, code, visible && !streaming && !mermaid)
  const markup = useMemo(() => ({ __html: (highlighted ?? code.split('\n').map(escapeCodeHtml))
    .map(line => `<span class="wc-fence-line">${line || '\n'}</span>`).join('') }), [code, highlighted])
  const source = <div className="wc-scrollbar wc-fence-body" data-streamdown="code-block-body" data-wrap={wrap}>
    <pre><code dangerouslySetInnerHTML={markup} /></pre>
  </div>
  const wrapAction = <button type="button" className="wc-icon-button size-7" aria-label="自动换行" aria-pressed={wrap}
    title={wrap ? '关闭自动换行' : '开启自动换行'} onClick={() => setWrap(value => !value)}><WrapText size={14} /></button>
  const actions = <>
    <CopyButton text={code} ariaLabel="复制代码" className="wc-icon-button size-7" />
    <CodeBlockDownloadButton code={code} language={language || 'txt'} className="wc-icon-button size-7" title="下载代码" aria-label="下载代码"><Download size={14} /></CodeBlockDownloadButton>
  </>
  return <div ref={ref} className="wc-markdown-code" data-language={language} data-streamdown="code-block" data-incomplete={streaming || undefined}>
    {mermaid && !streaming ? <MermaidDiagram key={`${owner?.key ?? ''}:${viewId ?? ''}:${code}`} viewId={viewId}
      code={code} visible={visible} source={source} actions={actions} wrapAction={wrapAction} /> : <>
      <div className="wc-fence-toolbar">
        <span className="min-w-0 flex-1 truncate" title={language}>{language || 'text'}</span>
        {wrapAction}{actions}
      </div>
      {source}
    </>}
  </div>
}
