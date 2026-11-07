import { askUserQuestionSchema, type UserQuestionItem } from '../../user-questions.ts'
import { buildTool } from '../tool.ts'

export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion'

export function createAskUserQuestionTool(onQuestion: (id: string, items: UserQuestionItem[]) => void) {
  return buildTool({
    name: ASK_USER_QUESTION_TOOL_NAME,
    description: '向用户提出一个或多个简短问题',
    prompt: '工作中需要补充信息、确认用户偏好或约束、澄清意图或取得批准，且无法从现有上下文或可用工具确定答案时，用此工具提出一个或多个简短问题。使用用户熟悉的语言，让每个问题都包含回答所需的背景。界面会自动提供自由输入，无需添加“其它”选项。调用会立即返回，当前回合可以继续执行。用户的回答会异步作为用户消息送达。等待期间，继续完成已获授权且不依赖回答的工作。如果剩余工作都依赖用户答复，可以结束当前回合等待。需要批准的操作须等用户明确同意后再执行。',
    inputSchema: askUserQuestionSchema,
    isReadOnly: false,
    kind: 'control',
    async execute(input, context) {
      if (!context.toolCallId) throw new Error('提问缺少工具调用 ID')
      onQuestion(context.toolCallId, input.questions)
      return { data: '问题已提交。', isError: false }
    },
  })
}
