import { SkillCatalogService, workspacePathKey, type SkillSummary } from '@whycode/core'
import type { SshSkillJob, SshSkillListing, SshSkillResult, SshSkillRow } from '../../shared/ssh-skills.ts'
import type { SshConnections } from './connections.ts'
import { exists } from './config-files.ts'
import { localWorkspaceIO, readSkillTree, remoteSkillIO, skillPath, SKILL_SYNC_BYTES, type SkillTree, type SkillWorkspaceIO } from './skill-files.ts'
import { cleanManagedSkills, managedSkills, publishSkill, skillRoot, type ManagedSkill } from './skill-remote.ts'

interface LocalSkill { id: string; skill: SkillSummary; digest?: string; error?: string }

/** Main 持有任务与有界结果；弹窗的卸载不取消文件传输。 */
export class SshSkillSync {
  private readonly jobs = new Map<string, SshSkillJob>()
  private readonly connections: SshConnections
  private readonly home: string
  private readonly changed: () => void
  constructor(connections: SshConnections, home: string, changed: () => void) { this.connections = connections; this.home = home; this.changed = changed }
  job(id: string): SshSkillJob | undefined { return this.jobs.get(id) }
  forget(id: string): void { this.jobs.delete(id) }

  /** 只消费新连接的首次同步机会；重连和清理后由用户主动同步。 */
  async initialize(id: string): Promise<void> {
    try {
      if (!await this.connections.store.takeSkillInitialization(id)) return
      const selected = (await this.local()).map(item => item.id)
      if (selected.length) await this.sync(id, selected)
    } catch (error) {
      if (!this.jobs.has(id)) await this.run(id, 'sync', ['.system'], async () => { throw error }).catch(() => undefined)
      this.changed()
    }
  }

  private async local(): Promise<LocalSkill[]> {
    const root = skillRoot(localWorkspaceIO, this.home)
    const prefix = `${workspacePathKey(localWorkspaceIO, root)}${localWorkspaceIO.path.sep}`
    const skills = (await new SkillCatalogService({ homeDir: this.home }).list(null)).skills
      .filter(skill => workspacePathKey(localWorkspaceIO, skill.rootPath).startsWith(prefix))
    const candidates = skills.filter(skill => !skills.some(other => other !== skill && skill.rootPath.startsWith(`${other.rootPath}${localWorkspaceIO.path.sep}`)))
    if (candidates.length > 200) throw new Error('本地 Skill 超过 200 个，请精简后同步')
    const result: LocalSkill[] = []
    for (const skill of candidates) {
      const id = localWorkspaceIO.path.relative(root, skill.rootPath).split(localWorkspaceIO.path.sep).join('/')
      try { result.push({ id, skill, digest: (await readSkillTree(localWorkspaceIO, skill.rootPath)).digest }) }
      catch (error) { result.push({ id, skill, error: error instanceof Error ? error.message : String(error) }) }
    }
    return result
  }

  private async inspect(io: SkillWorkspaceIO, home: string, local: LocalSkill[]): Promise<{ rows: SshSkillRow[]; managed: ManagedSkill[] }> {
    const managed = await managedSkills(io, home)
    const native = (await new SkillCatalogService({ homeDir: home, workspaceIO: io }).list(null)).skills
    const rows: SshSkillRow[] = []
    for (const item of local) {
      const remote = managed.find(entry => entry.id === item.id)
      const destination = skillPath(skillRoot(io, home), item.id, io.path)
      const conflict = native.some(skill => (skill.scope === item.skill.scope && skill.name === item.skill.name && skill.rootPath !== destination) || destination.startsWith(`${skill.rootPath}/`))
        || managed.some(entry => item.id.startsWith(`${entry.id}/`))
      const status = item.error || conflict || remote?.modified ? 'conflict'
        : remote ? remote.marker?.digest === item.digest ? 'same' : 'update'
        : await exists(io.fs, destination) ? 'conflict' : 'missing'
      rows.push({ id: item.id, name: item.skill.name, description: item.skill.description, status,
        local: true, managed: Boolean(remote), modified: remote?.modified ?? false,
        error: item.error ?? remote?.error ?? (conflict ? '远端已有同名 Skill 或属于其它 Skill 的目录，保留现有版本' : undefined) })
    }
    for (const entry of managed) if (!rows.some(row => row.id === entry.id)) {
      rows.push({ id: entry.id, name: entry.marker?.name ?? '未完成的 Skill 操作', description: entry.marker?.description ?? '', status: entry.modified ? 'conflict' : 'remote-only', local: false, managed: true, modified: entry.modified, error: entry.error })
    }
    return { rows, managed }
  }

  async list(id: string): Promise<SshSkillListing> {
    const local = await this.local()
    return this.connections.withFiles(id, async (fs, home, client) => {
      const io = remoteSkillIO(fs, home, client)
      return { rows: (await this.inspect(io, home, local)).rows, directory: skillRoot(io, home), job: this.job(id) }
    })
  }

  async sync(id: string, selected: string[]): Promise<SshSkillJob> {
    return this.run(id, 'sync', selected, async progress => this.connections.withConfigurationFiles(id, async (fs, home, client) => {
      const io = remoteSkillIO(fs, home, client)
      const local = await this.local()
      const inspection = await this.inspect(io, home, local)
      const packages: { candidate: LocalSkill; tree: SkillTree }[] = []
      let bytes = 0
      for (const key of selected) {
        const candidate = local.find(item => item.id === key)
        const row = inspection.rows.find(item => item.id === key)
        if (!candidate || !row) throw new Error(`Skill 已变化，请重新查看：${key}`)
        if (row.status === 'same') { progress({ id: key, name: row.name, ok: true, message: '内容一致' }); continue }
        if (row.status === 'conflict') {
          progress({ id: key, name: row.name, ok: false, message: row.error ?? '远端有修改，保留现有版本' })
          continue
        }
        const tree = await readSkillTree(localWorkspaceIO, candidate.skill.rootPath)
        bytes += tree.bytes
        if (bytes > SKILL_SYNC_BYTES) throw new Error('所选 Skill 内容超过单次 20 MiB 上限，请减少选择')
        packages.push({ candidate, tree })
      }
      for (const { candidate, tree } of packages) {
        try {
          await publishSkill(io, home, candidate.id, tree, candidate.skill, inspection.managed.find(entry => entry.id === candidate.id)?.marker?.digest)
          progress({ id: candidate.id, name: candidate.skill.name, ok: true, message: '已同步' })
        } catch (error) { progress({ id: candidate.id, name: candidate.skill.name, ok: false, message: error instanceof Error ? error.message : String(error) }) }
      }
    }))
  }

  clean(id: string, selected: string[], allowModified: string[]): Promise<SshSkillJob> {
    return this.run(id, 'clean', selected, progress => this.connections.withConfigurationFiles(id, (fs, home, client) =>
      cleanManagedSkills(remoteSkillIO(fs, home, client), home, { allowModified }, selected, progress)))
  }

  private async run(id: string, operation: SshSkillJob['operation'], selected: string[], work: (progress: (result: SshSkillResult) => void) => Promise<unknown>): Promise<SshSkillJob> {
    if (this.jobs.get(id)?.running) throw new Error('此服务器的 Skill 操作仍在后台进行')
    // 只保留最近 32 个连接的结果，不保留文件字节或历次任务历史。
    if (!this.jobs.has(id) && this.jobs.size >= 32) {
      const previous = [...this.jobs].find(([, job]) => !job.running)
      if (previous) this.jobs.delete(previous[0]); else throw new Error('后台 Skill 操作过多，请稍后重试')
    }
    const job: SshSkillJob = { operation, running: true, total: selected.length, results: [] }
    this.jobs.set(id, job); this.changed()
    try { await work(result => { job.results.push(result); this.changed() }); return job }
    catch (error) {
      for (const key of selected) if (!job.results.some(result => result.id === key)) job.results.push({ id: key, name: key, ok: false, message: error instanceof Error ? error.message : String(error) })
      throw error
    } finally { job.running = false; this.changed(); this.connections.emit('changed') }
  }
}
