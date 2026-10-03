import { z } from 'zod'
import type { SidebarProject } from './projects.ts'
import type { SshReleaseOptions, SshSkillJob, SshSkillListing } from './ssh-skills.ts'

export const sshConnectionInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(100),
  host: z.string().trim().min(1).max(253).regex(/^[^\s\0/@]+$/u),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().trim().min(1).max(100).regex(/^[^\s\0]+$/u),
  authentication: z.enum(['password', 'key', 'agent']),
  privateKeyPath: z.string().max(4096).optional(),
  secret: z.string().max(16384).optional(),
  rememberSecret: z.boolean().default(false),
})
export type SshConnectionInput = z.infer<typeof sshConnectionInputSchema>
export interface SshConnection extends Omit<SshConnectionInput, 'id' | 'secret'> {
  id: string
  fingerprint?: string
  hasSecret: boolean
}
export type SshConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'interrupted' | 'releasing'
export interface SshConnectionSnapshot extends SshConnection { status: SshConnectionStatus }

export function sshMessageUnavailableReason(status: SshConnectionStatus | undefined): string | null {
  switch (status) {
    case 'connected':
    case 'interrupted': return null
    case 'connecting': return 'SSH 正在连接，请连接完成后再发送'
    case 'releasing': return 'SSH 连接正在清理，请完成后重新连接再发送'
    case 'disconnected': return 'SSH 未连接，请先点击会话顶部或设置中的“连接”'
    case undefined: return '原 SSH 连接已删除，请在设置中重新添加并连接原服务器'
  }
}

export type SshConnectResult =
  | { status: 'connected'; home: string }
  | { status: 'trust-required'; fingerprint: string; host: string }
export interface SshDirectory { path: string; directories: string[] }
export type SshRequest =
  | { action: 'list' }
  | { action: 'resolve'; target: string }
  | { action: 'save'; connection: SshConnectionInput }
  | { action: 'connect'; id: string; fingerprint?: string; secret?: string }
  | { action: 'disconnect' | 'remove-local'; id: string }
  | ({ action: 'remove' | 'cleanup'; id: string } & SshReleaseOptions)
  | { action: 'skills-list' | 'skills-status'; id: string }
  | { action: 'skills-sync'; id: string; skills: string[] }
  | { action: 'skills-clean'; id: string; skills: string[]; allowModified: string[] }
  | { action: 'directory'; id: string; path?: string }
  | { action: 'project'; id: string; path: string }

export type SshResult = { ok: false; error: string; credentialsRequired?: boolean; modifiedSkills?: string[] } | {
  ok: true
  connections?: SshConnectionSnapshot[]
  connection?: SshConnectionSnapshot
  connect?: SshConnectResult
  directory?: SshDirectory
  project?: SidebarProject
  skills?: SshSkillListing
  skillJob?: SshSkillJob
  preservedSkills?: string[]
}
