import type { ModelMessage } from 'ai'
import { createImageUserMessage } from '../attachments/messages.ts'
import type { BtwTurnContext } from '../session/btw.ts'
import { READ_FILE_TOOL_NAME } from '../tools/read-file/index.ts'
import { LIST_DIR_TOOL_NAME, GLOB_TOOL_NAME } from '../tools/list-glob/index.ts'
import { GREP_TOOL_NAME } from '../tools/grep/index.ts'
import { WEB_SEARCH_TOOL_NAME } from '../tools/web-search/prompt.ts'
import { WEB_FETCH_TOOL_NAME, WEB_FIND_TOOL_NAME } from '../tools/web-page/prompt.ts'

export const BTW_TOOL_NAMES: ReadonlySet<string> = new Set([
  READ_FILE_TOOL_NAME, LIST_DIR_TOOL_NAME, GLOB_TOOL_NAME, GREP_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME, WEB_FETCH_TOOL_NAME, WEB_FIND_TOOL_NAME,
])

export const BTW_SYSTEM_PROMPT = 'BTW 是临时问答。收到宿主的 <whycode-btw> 标记时，'
  + '只回答当前临时问题，不推进主任务；工具仅限 '
  + `${[...BTW_TOOL_NAMES].join('、')}。`

/** 每轮输入与提醒一起重建，续问不会移动已发送的消息边界。 */
export function createBtwUserMessages(
  input: Pick<BtwTurnContext, 'text' | 'attachments'>,
): ModelMessage[] {
  return [
    input.attachments.length
      ? createImageUserMessage(input.text, input.attachments, 'native')
      : { role: 'user', content: input.text },
    {
      role: 'user',
      content: [
        '<whycode-btw version="1">',
        '宿主状态，非新的用户要求：当前为临时对话，按需使用允许的工具核实后回答用户的问题。',
        '</whycode-btw>',
      ].join('\n'),
    },
  ]
}
