import { z } from 'zod'

export const sshSkillIdSchema = z.string().min(1).max(1024).refine(value =>
  value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..' && !/[\\:\0]/u.test(part)),
  'Skill 目录名称无效')
export const sshSkillSelectionSchema = z.array(sshSkillIdSchema).min(1).max(2000)
export interface SshSkillRow {
  id: string
  name: string
  description: string
  status: 'missing' | 'same' | 'update' | 'conflict' | 'remote-only'
  local: boolean
  managed: boolean
  modified: boolean
  error?: string
}
export interface SshSkillResult { id: string; name: string; ok: boolean; message: string; preserved?: boolean }
export interface SshSkillJob {
  operation: 'sync' | 'clean'
  running: boolean
  total: number
  results: SshSkillResult[]
}
export interface SshSkillListing { rows: SshSkillRow[]; directory: string; job?: SshSkillJob }
export interface SshReleaseOptions { cleanSkills?: boolean; allowModified?: string[]; keepModified?: string[] }
