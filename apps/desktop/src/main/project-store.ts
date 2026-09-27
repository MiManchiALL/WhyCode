import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { validateSessionId } from '@whycode/core'
import { MAX_PROJECT_NAME_LENGTH, normalizeProjectName, type SidebarProject } from '../shared/projects.ts'
import { workspaceProjectDirectory, type RuntimeWorkspace } from '../shared/workspace.ts'
import { samePath } from './workspace-path.ts'

/** 项目登记只组织会话；移除登记不取得目录、会话或受管工作区的清理权。 */
export class ProjectStore {
  private projects: SidebarProject[] = []
  private tail: Promise<void> = Promise.resolve()
  private readonly path: string

  constructor(path: string) { this.path = path }

  async initialize(): Promise<void> {
    let value: unknown
    try { value = JSON.parse(await readFile(this.path, 'utf8')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    this.projects = parseProjects(value)
  }

  list(): SidebarProject[] { return structuredClone(this.projects) }

  get(id: unknown): SidebarProject {
    const project = this.projects.find(item => item.id === id)
    if (!project) throw new Error('项目不存在或已移除')
    return structuredClone(project)
  }

  async add(directory: string): Promise<SidebarProject> {
    const canonical = await realpath(directory)
    if (!(await stat(canonical)).isDirectory()) throw new Error('请选择文件夹')
    let result!: SidebarProject
    await this.update(projects => {
      const existing = projects.find(item => samePath(item.directory, canonical))
      if (existing) { result = existing; return projects }
      const name = normalizeProjectName((basename(canonical) || canonical).slice(0, MAX_PROJECT_NAME_LENGTH))
      result = { id: randomUUID(), name, directory: canonical, sessionIds: [] }
      return [...projects, result]
    })
    return structuredClone(result)
  }

  rename(id: unknown, value: unknown): Promise<void> {
    const name = normalizeProjectName(value)
    return this.update(projects => {
      this.get(id)
      return projects.map(item => item.id === id ? { ...item, name } : item)
    })
  }

  remove(id: unknown): Promise<void> {
    return this.update(projects => {
      this.get(id)
      return projects.filter(item => item.id !== id)
    })
  }

  attachSession(sessionId: string, workspace: RuntimeWorkspace): Promise<void> {
    validateSessionId(sessionId)
    const directory = workspaceProjectDirectory(workspace)
    return this.update(projects => {
      const project = directory && projects.find(item => samePath(item.directory, directory))
      if (!project || project.sessionIds.includes(sessionId)) return projects
      return projects.map(item => item === project ? { ...item, sessionIds: [...item.sessionIds, sessionId] } : item)
    })
  }

  inheritSession(sourceId: string, sessionId: string): Promise<void> {
    validateSessionId(sessionId)
    return this.update(projects => {
      const project = projects.find(item => item.sessionIds.includes(sourceId))
      if (!project || project.sessionIds.includes(sessionId)) return projects
      return projects.map(item => item === project ? { ...item, sessionIds: [...item.sessionIds, sessionId] } : item)
    })
  }

  detachSession(sessionId: string): Promise<void> {
    return this.update(projects => projects.some(item => item.sessionIds.includes(sessionId))
      ? projects.map(item => ({ ...item, sessionIds: item.sessionIds.filter(id => id !== sessionId) })) : projects)
  }

  private update(transform: (projects: SidebarProject[]) => SidebarProject[]): Promise<void> {
    const pending = this.tail.then(async () => {
      const next = transform(this.projects)
      if (next === this.projects) return
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const temporary = join(dirname(this.path), `.projects-${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, `${JSON.stringify({ version: 1, projects: next }, null, 2)}\n`, { mode: 0o600, flag: 'wx', flush: true })
        await rename(temporary, this.path)
        this.projects = next
      } finally { await rm(temporary, { force: true }) }
    })
    this.tail = pending.catch(() => {})
    return pending
  }
}

function parseProjects(value: unknown): SidebarProject[] {
  const invalid = () => { throw new Error('项目登记文件格式无效') }
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1
    || !('projects' in value) || !Array.isArray(value.projects)) return invalid()
  const ids = new Set<string>()
  const sessionIds = new Set<string>()
  const projects: SidebarProject[] = []
  for (const item of value.projects) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string'
      || typeof item.directory !== 'string' || !isAbsolute(item.directory) || !Array.isArray(item.sessionIds)) return invalid()
    validateSessionId(item.id)
    if (ids.has(item.id) || projects.some(project => samePath(project.directory, item.directory))) return invalid()
    ids.add(item.id)
    for (const id of item.sessionIds) {
      if (typeof id !== 'string' || sessionIds.has(id)) return invalid()
      validateSessionId(id)
      sessionIds.add(id)
    }
    projects.push({ id: item.id, name: normalizeProjectName(item.name), directory: item.directory, sessionIds: item.sessionIds })
  }
  return projects
}
