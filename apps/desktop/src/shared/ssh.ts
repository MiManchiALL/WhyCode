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
export type SshConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'releasing'
export interface SshConnectionSnapshot extends SshConnection { status: SshConnectionStatus }
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
