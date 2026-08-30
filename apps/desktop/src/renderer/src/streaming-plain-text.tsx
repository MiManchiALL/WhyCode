import { useLayoutEffect, useRef } from 'react'
import { incrementalTextSuffix } from './streaming-plain-text.ts'

/**
 * React 仍持有完整权威文本，但流式 DOM 只追加新增字符。这样保持完整可见、
 * 可选择的思考过程，同时避免每个增量都替换越来越大的原生文本节点。
 */
export function StreamingPlainText({
  text,
  resetKey,
  className,
}: {
  text: string
  resetKey: string
  className?: string
}) {
  const elementRef = useRef<HTMLDivElement>(null)
  const renderedRef = useRef({ resetKey, text: '' })

  useLayoutEffect(() => {
    const element = elementRef.current
    if (!element) return
    const rendered = renderedRef.current
    const suffix = rendered.resetKey === resetKey
      ? incrementalTextSuffix(rendered.text, text)
      : null
    const textNode = element.firstChild
    if (
      suffix !== null
      && textNode?.nodeType === Node.TEXT_NODE
      && textNode === element.lastChild
    ) {
      if (suffix) (textNode as Text).appendData(suffix)
    } else {
      element.textContent = text
    }
    renderedRef.current = { resetKey, text }
  }, [resetKey, text])

  return <div ref={elementRef} className={className} />
}
