import { PRESENT_TOOL_NAME, readPresentationResult, type Presentation } from '@whycode/core/presentation'
import type { WebSource } from '@whycode/core/web-source'
import { createContext } from 'react'
import type { Link } from 'mdast'
import type { Block } from '../../shared/conversation-state.ts'
import { fileName } from './local-files.ts'
import { normalizeMathDelimiters, parseMarkdown } from './markdown-rendering.ts'
import { sourceCitations } from './markdown-sources.ts'

export interface ResponseSources {
  sources: readonly WebSource[]
  copyText: string
}

export const ResponseSourcesContext = createContext<ResponseSources | null>(null)

/** 只在最终正文变化时解析；语法树随投影释放，引用不形成另一份持久状态。 */
export function responseSources(texts: readonly string[]): ResponseSources {
  const sources = new Map<string, WebSource>()
  const copyTexts = texts.map(text => {
    const markdown = normalizeMathDelimiters(text)
    const citations = sourceCitations(parseMarkdown(markdown))
    if (!citations.length) return text
    const replacements = new Map<number, { end: number; text: string }>()
    const replace = (position: Link['position'], value: string) => {
      const start = position?.start.offset
      const end = position?.end.offset
      if (start !== undefined && end !== undefined) replacements.set(start, { end, text: value })
    }
    for (const { node, source, definition } of citations) {
      if (!sources.has(source.url)) sources.set(source.url, source)
      replace(node.position, markdownLink(source.title, source.url))
      if (definition) replace(definition.position, `[${markdownLabel(definition.label ?? definition.identifier)}]: <${markdownTarget(source.url)}>`)
    }
    let copyText = markdown
    for (const [start, replacement] of [...replacements].sort((a, b) => b[0] - a[0])) {
      copyText = copyText.slice(0, start) + replacement.text + copyText.slice(replacement.end)
    }
    return copyText
  })
  return { sources: [...sources.values()], copyText: copyTexts.join('\n\n') }
}

/** 保留结果字符串身份，避免无关流式更新重建整段历史的交付上下文。 */
export function responsePresentationResult(activity: readonly Block[]): string | null {
  for (let index = activity.length - 1; index >= 0; index--) {
    const block = activity[index]!
    if (block.kind !== 'tool') continue
    const { call } = block
    if (call.name === PRESENT_TOOL_NAME && call.status === 'done' && call.result
      && readPresentationResult(call.result)) return call.result
  }
  return null
}

export function copyResponseText(response: ResponseSources, presentation: Presentation | null): string {
  const sections = [response.copyText]
  if (presentation?.files.length) sections.push(presentation.files.map(file =>
    '- ' + markdownLink(fileName(file.path), file.path.replaceAll('\\', '/'))
    + (file.description ? ` — ${file.description}` : '')).join('\n'))
  if (response.sources.length) sections.push('### 来源\n\n' + response.sources.map(source =>
    '- ' + markdownLink(source.title, source.url)).join('\n'))
  return sections.join('\n\n')
}

function markdownLink(title: string, target: string): string {
  return `[${markdownLabel(title)}](<${markdownTarget(target)}>)`
}

function markdownLabel(title: string): string {
  return title.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]')
}

function markdownTarget(target: string): string {
  return target.replaceAll('<', '%3C').replaceAll('>', '%3E')
}
