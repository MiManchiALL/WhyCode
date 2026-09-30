import { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import { IPC } from '../../shared/ipc.ts'
import { sshConnectionInputSchema, type SshResult } from '../../shared/ssh.ts'
import type { ProjectStore } from '../project-store.ts'
import type { SshWorkspaces } from './workspaces.ts'
import { SshCredentialsRequiredError } from './connections.ts'
import { SshConnectionMissingError } from './store.ts'

const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('resolve'), target: z.string().min(1).max(4096) }),
  z.object({ action: z.literal('save'), connection: sshConnectionInputSchema }),
  z.object({ action: z.literal('connect'), id: z.string().uuid(), fingerprint: z.string().optional(), secret: z.string().max(16384).optional() }),
  z.object({ action: z.enum(['disconnect', 'remove', 'cleanup']), id: z.string().uuid() }),
  z.object({ action: z.literal('directory'), id: z.string().uuid(), path: z.string().max(4096).optional() }),
  z.object({ action: z.literal('project'), id: z.string().uuid(), path: z.string().max(4096) }),
])
export function registerSshIpc(workspaces: SshWorkspaces, projects: ProjectStore): void {
  const connections = workspaces.connections
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
          if (request.connection.id) connections.disconnect(request.connection.id)
          const connection = await connections.store.save(request.connection)
          connections.emit('changed')
          return { ok: true, connection: { ...connection, status: connections.status(connection.id) } }
        }
        case 'connect': return { ok: true, connect: await connections.connect(request.id, request.fingerprint, request.secret) }
        case 'directory': return { ok: true, directory: await connections.directory(request.id, request.path) }
        case 'disconnect': connections.disconnect(request.id); return { ok: true }
        case 'cleanup': await connections.cleanup(request.id); return { ok: true }
        case 'remove': await connections.remove(request.id); return { ok: true }
        case 'project': {
          const binding = await workspaces.select(connections.host(request.id).target, request.path)
          return { ok: true, project: await projects.addRemote(binding) }
        }
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error),
        ...(error instanceof SshCredentialsRequiredError ? { credentialsRequired: true } : {}) }
    }
  })
}
