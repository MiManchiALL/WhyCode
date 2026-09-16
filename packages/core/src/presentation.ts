import { z } from 'zod'

export const PRESENT_TOOL_NAME = 'Present'
const singleLine = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]+$/u)

export const presentedSourceSchema = z.object({
  title: singleLine(200),
  url: singleLine(2048).url().refine(value => {
    try {
      const url = new URL(value)
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
    } catch { return false }
  }, '来源必须是无凭据的 HTTP(S) URL'),
}).strict()

export const presentationSchema = z.object({
  files: z.array(z.object({
    path: singleLine(2048),
    description: singleLine(160).optional(),
  }).strict()).max(8).describe('本次回答的最终文件；没有则填空数组'),
  sources: z.array(presentedSourceSchema).max(16).describe('本次回答实际引用的来源；无需来源则填空数组'),
}).strict().refine(value => JSON.stringify(value).length <= 32 * 1024, '交付声明过长，请精简路径和说明')

export type Presentation = z.infer<typeof presentationSchema>
export type PresentedFile = Presentation['files'][number]
export type PresentedSource = Presentation['sources'][number]

/** 只解码成功的 Present 结果；历史与实时视图共用工具返回的声明。 */
export function readPresentationResult(result: string): Presentation | null {
  try {
    const parsed = presentationSchema.safeParse(JSON.parse(result))
    return parsed.success ? parsed.data : null
  } catch { return null }
}
