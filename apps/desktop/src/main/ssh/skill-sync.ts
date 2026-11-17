import { SkillCatalogService, workspacePathKey, type SkillSummary } from '@whycode/core'
import type { SshSkillJob, SshSkillListing, SshSkillResult, SshSkillRow } from '../../shared/ssh-skills.ts'
import type { SshConnections } from './connections.ts'
import { exists, mapFileOperations } from './config-files.ts'
import { localWorkspaceIO, readSkillTree, remoteSkillIO, skillPath, SKILL_SYNC_BYTES, type SkillTree, type SkillWorkspaceIO } from './skill-files.ts'
import { cleanManagedSkills, managedSkills, publishSkill, skillRoot } from './skill-remote.ts'

interface LocalSkill { id: string; skill: SkillSummary }
interface InspectedSkill { row: SshSkillRow; tree?: SkillTree; previous?: string }

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
      const local = await this.local()
      if (local.length) await this.syncSelection(id, local.map(item => item.id), local)
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
    return candidates.map(skill => ({ id: localWorkspaceIO.path.relative(root, skill.rootPath).split(localWorkspaceIO.path.sep).join('/'), skill }))
  }

  private async *inspect(io: SkillWorkspaceIO, home: string, candidates: LocalSkill[], selected?: string[]): AsyncGenerator<InspectedSkill> {
    const local = selected ? selected.map(id => {
      const item = candidates.find(candidate => candidate.id === id)
      if (!item) throw new Error(`Skill 已变化，请重新查看：${id}`)
      return item
    }) : candidates
    const managed = await managedSkills(io, home, selected)
    // 同名冲突可能来自任意原生 Skill，包括不在所选目录下的 .agents 副本。
    const native = local.length ? (await new SkillCatalogService({ homeDir: home, workspaceIO: io }).list(null)).skills : []
    const targets = await mapFileOperations(local, async item => {
      const remote = managed.find(entry => entry.id === item.id)
      const destination = skillPath(skillRoot(io, home), item.id, io.path)
      const conflict = native.some(skill => (skill.scope === item.skill.scope && skill.name === item.skill.name && skill.rootPath !== destination) || destination.startsWith(`${skill.rootPath}/`))
        || managed.some(entry => item.id.startsWith(`${entry.id}/`))
      const occupied = !conflict && !remote && Boolean(await exists(io.fs, destination))
      return { item, remote, conflict, occupied }
    })
    for (const { item, remote, conflict, occupied } of targets) {
      let tree: SkillTree | undefined
      let error: string | undefined
      try { tree = await readSkillTree(localWorkspaceIO, item.skill.rootPath) }
      catch (failure) { error = failure instanceof Error ? failure.message : String(failure) }
      const status = !tree || occupied || conflict || remote?.modified ? 'conflict'
        : remote ? remote.marker?.digest === tree.digest ? 'same' : 'update' : 'missing'
      const row: SshSkillRow = {
        id: item.id, name: item.skill.name, description: item.skill.description, status,
        local: true, managed: Boolean(remote), modified: remote?.modified ?? false,
        error: error ?? remote?.error ?? (conflict ? '远端已有同名 Skill 或属于其它 Skill 的目录，保留现有版本' : undefined),
      }
      yield { row, tree, previous: remote?.marker?.digest }
    }
    if (selected) return
    for (const entry of managed) {
      if (local.some(item => item.id === entry.id)) continue
      yield { row: {
        id: entry.id, name: entry.marker?.name ?? '未完成的 Skill 操作', description: entry.marker?.description ?? '',
        status: entry.modified ? 'conflict' : 'remote-only', local: false, managed: true, modified: entry.modified, error: entry.error,
      } }
    }
  }

  async list(id: string): Promise<SshSkillListing> {
    const local = await this.local()
    return this.connections.withFiles(id, async (fs, home, client) => {
      const io = remoteSkillIO(fs, home, client)
      const rows: SshSkillRow[] = []
      for await (const { row } of this.inspect(io, home, local)) rows.push(row)
      return { rows, directory: skillRoot(io, home), job: this.job(id) }
    })
  }

  sync(id: string, selected: string[]): Promise<SshSkillJob> {
    return this.syncSelection(id, selected)
  }

  private syncSelection(id: string, selected: string[], local?: LocalSkill[]): Promise<SshSkillJob> {
    return this.run(id, 'sync', selected, async progress => this.connections.withConfigurationFiles(id, async (fs, home, client) => {
      const io = remoteSkillIO(fs, home, client)
      const packages: { row: SshSkillRow; tree: SkillTree; previous?: string }[] = []
      let bytes = 0
      for await (const { row, tree, previous } of this.inspect(io, home, local ?? await this.local(), selected)) {
        if (row.status === 'same') { progress({ id: row.id, name: row.name, ok: true, message: '内容一致' }); continue }
        if (!tree || row.status === 'conflict') {
          progress({ id: row.id, name: row.name, ok: false, message: row.error ?? '远端有修改，保留现有版本' })
          continue
        }
        bytes += tree.bytes
        if (bytes > SKILL_SYNC_BYTES) throw new Error('所选 Skill 内容超过单次 20 MiB 上限，请减少选择')
        packages.push({ row, tree, previous })
      }
      for (const { row, tree, previous } of packages) {
        try {
          await publishSkill(io, home, row.id, tree, row, previous)
          progress({ id: row.id, name: row.name, ok: true, message: '已同步' })
        } catch (error) { progress({ id: row.id, name: row.name, ok: false, message: error instanceof Error ? error.message : String(error) }) }
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
