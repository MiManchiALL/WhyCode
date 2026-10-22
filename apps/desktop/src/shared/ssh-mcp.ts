import { z } from 'zod'

export const remoteMcpProjectPathSchema = z.string().min(1).max(4096)
  .refine(path => path.startsWith('/') && !/[\0\r\n]/u.test(path), '远端项目路径无效')
export const remoteMcpSelectionSchema = z.object({
  directory: remoteMcpProjectPathSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
})
export type RemoteMcpSelection = z.infer<typeof remoteMcpSelectionSchema>
export interface RemoteMcpProject {
  directory: string
  digest?: string
  incomplete?: boolean
  error?: string
}
export interface RemoteMcpDocument {
  target: string
  directory: string
  text: string
  digest: string | null
}
export const remoteMcpSaveSchema = z.object({
  target: z.string().min(1).max(4096),
  directory: remoteMcpProjectPathSchema,
  text: z.string().max(256 * 1024),
  digest: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
})
