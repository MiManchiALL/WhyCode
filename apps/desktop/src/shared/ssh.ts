import { z } from 'zod'
import type { SidebarProject } from './projects.ts'

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
  connected?: boolean
}
export type SshConnectResult =
  | { status: 'connected'; home: string }
  | { status: 'trust-required'; fingerprint: string; host: string }
export interface SshDirectory { path: string; directories: string[] }
export type SshRequest =
  | { action: 'list' }
  | { action: 'save'; connection: SshConnectionInput }
  | { action: 'connect'; id: string; fingerprint?: string; secret?: string }
  | { action: 'disconnect' | 'remove' | 'cleanup'; id: string }
  | { action: 'directory'; id: string; path?: string }
  | { action: 'project'; id: string; path: string }

export type SshResult = { ok: false; error: string; credentialsRequired?: boolean } | {
  ok: true
  connections?: SshConnection[]
  connection?: SshConnection
  connect?: SshConnectResult
  directory?: SshDirectory
  project?: SidebarProject
}
