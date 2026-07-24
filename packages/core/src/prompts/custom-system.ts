import { z } from 'zod'

export const CUSTOM_SYSTEM_PROMPT_MAX_BYTES = 32 * 1024

export const customSystemPromptSnapshotSchema = z.object({
  mode: z.enum(['append', 'replace']),
  content: z.string().min(1),
}).superRefine((snapshot, ctx) => {
  if (!snapshot.content.trim()) {
    ctx.addIssue({
      code: 'custom',
      path: ['content'],
      message: '自定义 System 不能为空',
    })
  }
  if (Buffer.byteLength(snapshot.content, 'utf8') > CUSTOM_SYSTEM_PROMPT_MAX_BYTES) {
    ctx.addIssue({
      code: 'custom',
      path: ['content'],
      message: `自定义 System 不能超过 ${CUSTOM_SYSTEM_PROMPT_MAX_BYTES} 字节`,
    })
  }
})

export type CustomSystemPromptSnapshot = z.infer<typeof customSystemPromptSnapshotSchema>
