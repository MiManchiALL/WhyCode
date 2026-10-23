import { posix } from 'node:path'
import { withMcpServer, withMcpServerEnabled, type WorkspaceIO } from '@whycode/core'
import type { AddMcpServerRequest, SetMcpServerEnabledRequest } from '../../shared/settings.ts'
import type { RemoteMcpDocument, RemoteMcpSelection } from '../../shared/ssh-mcp.ts'
import type { RuntimeWorkspace } from '../../shared/workspace.ts'
import type { SshConnections } from './connections.ts'
import { RemoteMcpFiles } from './mcp-files.ts'
import { remoteMcpEnvironment } from './mcp-transport.ts'

export class SshMcpProjects {
  private readonly connections: SshConnections
  private readonly knownProjects: (target: string) => string[]
  private readonly invalidate: (target: string, directory: string) => Promise<void>
  constructor(
    connections: SshConnections,
    knownProjects: (target: string) => string[],
    invalidate: (target: string, directory: string) => Promise<void>,
  ) { this.connections = connections; this.knownProjects = knownProjects; this.invalidate = invalidate }

  private async withFiles<T>(target: string, operation: (files: RemoteMcpFiles) => Promise<T>): Promise<T> {
    const id = await this.connections.connectionIdForTarget(target)
    return this.connections.withConfigurationFiles(id, (fs, home) => {
      const io: WorkspaceIO = { identity: target, platform: 'linux', path: posix, fs }
      return operation(new RemoteMcpFiles(io, home))
    }, target, true)
  }

  options(workspace: Extract<RuntimeWorkspace, { mode: 'ssh' }>) {
    return {
      projectDir: workspace.workingDirectory,
      projectIO: this.connections.io(workspace.target),
      projectReadFile: () => this.withFiles(workspace.target, files => files.load(workspace.workingDirectory)),
      projectEnvironment: (names: readonly string[]) => remoteMcpEnvironment(this.connections.targetHost(workspace.target).client, names),
    }
  }

  async read(target: string, directory: string): Promise<RemoteMcpDocument> {
    return this.withFiles(target, async files => ({ target, directory, ...await files.read(directory) }))
  }

  async save(document: RemoteMcpDocument): Promise<void> {
    await this.withFiles(document.target, files => files.save(document.directory, document.text, document.digest))
  }

  async mutate(workspace: Extract<RuntimeWorkspace, { mode: 'ssh' }>, request: AddMcpServerRequest | SetMcpServerEnabledRequest): Promise<void> {
    await this.withFiles(workspace.target, async files => {
      const directory = workspace.workingDirectory
      const original = await files.read(directory)
      const raw: unknown = JSON.parse(original.text)
      const updated = 'server' in request
        ? withMcpServer(raw, request.name.trim(), request.server)
        : withMcpServerEnabled(raw, request.name, request.enabled)
      await files.save(directory, JSON.stringify(updated, null, 2) + '\n', original.digest)
    })
  }

  private async target(id: string): Promise<string> {
    for (const [target, connection] of await this.connections.configuredTargets()) if (connection.id === id) return target
    throw new Error('请先连接并确认服务器指纹')
  }

  async list(id: string, directory?: string) {
    const target = await this.target(id)
    return this.withFiles(target, files => files.list([...this.knownProjects(target), ...(directory ? [directory] : [])]))
  }

  async remove(id: string, selection: RemoteMcpSelection[]): Promise<void> {
    const target = await this.target(id)
    await this.withFiles(target, files => files.remove(selection, directory => this.invalidate(target, directory)))
  }
}
