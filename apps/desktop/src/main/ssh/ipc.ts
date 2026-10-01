import { app, BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import { IPC } from '../../shared/ipc.ts'
import { sshConnectionInputSchema, type SshResult } from '../../shared/ssh.ts'
import type { ProjectStore } from '../project-store.ts'
import type { SshWorkspaces } from './workspaces.ts'
import { SshCredentialsRequiredError } from './connections.ts'
import { SshConnectionMissingError } from './store.ts'
import { SshSkillSync } from './skill-sync.ts'
import { ModifiedSshSkillsError } from './skill-remote.ts'
import { sshSkillIdSchema, sshSkillSelectionSchema } from '../../shared/ssh-skills.ts'

const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('resolve'), target: z.string().min(1).max(4096) }),
  z.object({ action: z.literal('save'), connection: sshConnectionInputSchema }),
  z.object({ action: z.literal('connect'), id: z.string().uuid(), fingerprint: z.string().optional(), secret: z.string().max(16384).optional() }),
  z.object({ action: z.enum(['disconnect', 'remove-local']), id: z.string().uuid() }),
  z.object({ action: z.enum(['remove', 'cleanup']), id: z.string().uuid(), cleanSkills: z.boolean().optional(), allowModified: z.array(sshSkillIdSchema).max(2000).optional(), keepModified: z.array(sshSkillIdSchema).max(2000).optional() }),
  z.object({ action: z.enum(['skills-list', 'skills-status']), id: z.string().uuid() }),
  z.object({ action: z.literal('skills-sync'), id: z.string().uuid(), skills: sshSkillSelectionSchema.max(200) }),
  z.object({ action: z.literal('skills-clean'), id: z.string().uuid(), skills: sshSkillSelectionSchema, allowModified: z.array(sshSkillIdSchema).max(2000) }),
  z.object({ action: z.literal('directory'), id: z.string().uuid(), path: z.string().max(4096).optional() }),
  z.object({ action: z.literal('project'), id: z.string().uuid(), path: z.string().max(4096) }),
])
export function registerSshIpc(workspaces: SshWorkspaces, projects: ProjectStore, onSkillsChanged: () => void): void {
  const connections = workspaces.connections
  const skills = new SshSkillSync(connections, app.getPath('home'), onSkillsChanged)
  ipcMain.handle(IPC.ssh, async (event, value: unknown): Promise<SshResult> => {
    try {
      if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('仅主页面可管理 SSH 连接')
      const request = requestSchema.parse(value)
      switch (request.action) {
        case 'list': return { ok: true, connections: (await connections.store.list()).map(connection => ({ ...connection, status: connections.status(connection.id) })) }
        case 'resolve': {
          const id = await connections.connectionIdForTarget(request.target).catch(error => {
            if (error instanceof SshConnectionMissingError) return null
            throw error
          })
          if (!id) return { ok: true }
          return { ok: true, connection: { ...(await connections.store.get(id)).connection, status: connections.status(id) } }
        }
        case 'save': {
          const connection = await connections.save(request.connection)
          return { ok: true, connection: { ...connection, status: connections.status(connection.id) } }
        }
        case 'connect': return { ok: true, connect: await connections.connect(request.id, request.fingerprint, request.secret) }
        case 'directory': return { ok: true, directory: await connections.directory(request.id, request.path) }
        case 'disconnect': connections.disconnect(request.id); return { ok: true }
        case 'cleanup': return { ok: true, preservedSkills: await connections.cleanup(request.id, request) }
        case 'remove': {
          const preservedSkills = await connections.remove(request.id, request)
          skills.forget(request.id); return { ok: true, preservedSkills }
        }
        case 'remove-local': await connections.removeLocal(request.id); skills.forget(request.id); return { ok: true }
        case 'skills-status': return { ok: true, skillJob: skills.job(request.id) }
        case 'skills-list': return { ok: true, skills: await skills.list(request.id) }
        case 'skills-sync': return { ok: true, skillJob: await skills.sync(request.id, [...new Set(request.skills)]) }
        case 'skills-clean': return { ok: true, skillJob: await skills.clean(request.id, [...new Set(request.skills)], request.allowModified) }
        case 'project': {
          const binding = await workspaces.select(connections.host(request.id).target, request.path)
          return { ok: true, project: await projects.addRemote(binding) }
        }
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error),
        ...(error instanceof SshCredentialsRequiredError ? { credentialsRequired: true } : {}),
        ...(error instanceof ModifiedSshSkillsError ? { modifiedSkills: error.skills } : {}) }
    }
  })
}
