import { PRESENT_TOOL_NAME, readPresentationResult, type Presentation } from '@whycode/core/presentation'
import { createContext } from 'react'
import type { Block } from '../../shared/conversation-state.ts'
import { fileName } from './local-files.ts'

export const ResponsePresentationContext = createContext<Presentation | null>(null)

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

export function copyResponseText(text: string, presentation: Presentation | null): string {
  const sections = [text]
  if (presentation?.files.length) sections.push(presentation.files.map(file =>
    markdownLink(fileName(file.path), file.path.replaceAll('\\', '/'))
    + (file.description ? ` — ${file.description}` : '')).join('\n'))
  if (presentation?.sources.length) sections.push('### 来源\n\n' + presentation.sources.map(source =>
    markdownLink(source.title, source.url)).join('\n'))
  return sections.join('\n\n')
}

function markdownLink(title: string, target: string): string {
  const label = title.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]')
  const url = target.replaceAll('<', '%3C').replaceAll('>', '%3E')
  return `- [${label}](<${url}>)`
}
