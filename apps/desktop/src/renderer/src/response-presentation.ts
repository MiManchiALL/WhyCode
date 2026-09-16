import { PRESENT_TOOL_NAME, readPresentationResult, type Presentation } from '@whycode/core/presentation'
import type { Block, ToolCall } from '../../shared/conversation-state.ts'
import { fileName } from './local-files.ts'

export function toolPresentation(call: ToolCall): Presentation | null {
  return call.name === PRESENT_TOOL_NAME && call.status === 'done' && call.result
    ? readPresentationResult(call.result) : null
}

/** 工作分组已确定本次回答的边界；失败声明不覆盖最近一次成功声明。 */
export function responsePresentation(activity: readonly Block[]): Presentation | null {
  for (let index = activity.length - 1; index >= 0; index--) {
    const block = activity[index]!
    if (block.kind !== 'tool') continue
    const presentation = toolPresentation(block.call)
    if (presentation) return presentation
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
