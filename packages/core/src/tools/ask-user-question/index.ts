import { z } from 'zod'
import {
  MAX_USER_QUESTIONS,
  type UserQuestion,
} from '../../events.ts'
import { buildTool } from '../tool.ts'

export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion'

const optionSchema = z.object({
  label: z.string().min(1).max(40).describe('简短选项名称'),
  description: z.string().min(1).max(240).describe('这个选项的影响或取舍'),
})

const questionSchema = z.object({
  header: z.string().min(1).max(12).describe('问题卡的短标题，不超过 12 个字符'),
  question: z.string().min(1).max(500).describe('需要用户明确回答的问题'),
  options: z.array(optionSchema).min(2).max(4).describe('2~4 个互斥建议选项；界面会自动提供自由输入'),
})

const batchInputSchema = z.object({
  questions: z.array(questionSchema).min(1).max(MAX_USER_QUESTIONS)
    .describe('1~6 个都对继续行动必不可少的问题，按回答顺序排列'),
})

/**
 * 对模型始终暴露根级 object 批次 schema；preprocess 只在运行时接住升级前已缓存的
 * 单题调用，避免根级 anyOf 被部分函数调用协议拒绝。
 */
const inputSchema = z.preprocess((value) =>
  isLegacyQuestionInput(value) ? { questions: [value] } : value,
batchInputSchema)

export function createAskUserQuestionTool(
  onQuestion: (question: UserQuestion) => void,
) {
  let questionSubmitted = false
  return buildTool({
    name: ASK_USER_QUESTION_TOOL_NAME,
    description: '暂停尚未完成的任务，并向用户请求继续所必需的决策',
    prompt:
      '仅当用户回答会实质改变下一步行动，且无法从现有上下文或只读工具查明时使用。若存在安全、合理且容易撤销的默认选择，应直接继续并说明假设。已有休眠任务计划时，如果最新用户只提出了另一个复杂目标、但没有明确是否用它覆盖旧计划，可以询问用户保留旧计划还是原子替换；用户已明确授权替换时不要重复确认。若当前请求已经可以完整交付，不得调用本工具；应正常完成，并在最终文本中说明可选方向。不得用本工具询问用户是否满意、是否还需要帮助，或对已经明确的恢复意图再次确认。一次提交 1~6 个都对继续行动必不可少的问题；每题提供 2~4 个互斥选项及具体取舍，不要添加“其它”，界面会自动提供自由输入。调用成功会暂停当前回合，等待用户回答完整批次。',
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
      const questions = input.questions
      const first = questions[0]!
      onQuestion({ id: crypto.randomUUID(), ...first, questions })
      return {
        data: '问题批次已展示给用户；当前回合结束，等待用户全部回答后继续。',
        isError: false,
      }
    },
  })
}

function isLegacyQuestionInput(value: unknown): boolean {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && !('questions' in value),
  )
}
