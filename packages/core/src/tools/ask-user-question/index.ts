import { z } from 'zod'
import type { UserQuestion } from '../../events.ts'
import { buildTool } from '../tool.ts'

export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion'

const optionSchema = z.object({
  label: z.string().min(1).max(40).describe('简短选项名称'),
  description: z.string().min(1).max(240).describe('这个选项的影响或取舍'),
})

const inputSchema = z.object({
  header: z.string().min(1).max(12).describe('问题卡的短标题，不超过 12 个字符'),
  question: z.string().min(1).max(500).describe('需要用户明确回答的单个问题'),
  options: z.array(optionSchema).min(2).max(4).describe('2~4 个互斥建议选项；界面会自动提供自由输入'),
})

export function createAskUserQuestionTool(
  onQuestion: (question: UserQuestion) => void,
) {
  let questionSubmitted = false
  return buildTool({
    name: ASK_USER_QUESTION_TOOL_NAME,
    description: '向用户提出一个需要明确决策的问题',
    prompt:
      '仅当缺失信息会实质改变结果、且无法从现有上下文或只读工具查明时使用。一次只问一个清晰问题，提供 2~4 个互斥选项及具体取舍；不要添加“其它”，界面会自动提供自由输入。若存在安全且合理的默认选择，应直接继续并说明假设，不要用问题打断用户。调用成功会结束当前回合，用户回答后再继续原任务。',
    inputSchema,
    isReadOnly: false,
    kind: 'control',
    availableWithoutProject: true,
    endsTurnOnSuccess: true,
    turnEndReasonOnSuccess: 'waiting-user',
    async execute(input) {
      if (questionSubmitted) {
        return {
          data: '本回合已经提交了一个问题；请等待用户回答，不要重复提问。',
          isError: true,
        }
      }
      questionSubmitted = true
      onQuestion({ id: crypto.randomUUID(), ...input })
      return {
        data: '问题已展示给用户；当前回合结束，等待用户回答后继续。',
        isError: false,
      }
    },
  })
}
