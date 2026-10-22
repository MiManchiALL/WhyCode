import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { readBoundedWorkspaceFile, skillSummarySchema, type WorkspaceIO } from '@whycode/core'
import type { SshReleaseOptions, SshSkillResult } from '../../shared/ssh-skills.ts'
import { exists, ordinaryDirectory, pruneEmptyParents } from './config-files.ts'
import { mapSkillFiles, skillTreeDigest, skillPath, SKILL_SYNC_MARKER, type SkillTree, type SkillWorkspaceIO } from './skill-files.ts'

const markerSchema = skillSummarySchema.pick({ name: true, description: true }).extend({
  owner: z.literal('whycode-skill-sync'),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict()
export type SkillMarker = z.infer<typeof markerSchema>
export interface ManagedSkill { id: string; marker: SkillMarker | null; modified: boolean; error?: string }
export class ModifiedSshSkillsError extends Error {
  readonly skills: string[]
  constructor(skills: string[]) { super('部分已同步 Skill 在服务器上有修改，请选择是否一并清理'); this.skills = skills }
}
export const skillRoot = (io: WorkspaceIO, home: string) => io.path.join(home, '.whycode', 'skills')
const isStaging = (id: string) => /^\.whycode-sync-[a-f0-9-]{36}$/u.test(id)
const temporaryPath = (io: WorkspaceIO, home: string) => io.path.join(skillRoot(io, home), `.whycode-sync-${randomUUID()}`)

async function markerAt(io: WorkspaceIO, directory: string): Promise<SkillMarker | null> {
  const file = io.path.join(directory, SKILL_SYNC_MARKER)
  const info = await exists(io.fs, file)
  if (!info) return null
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Skill 归属记录无效：${directory}`)
  return markerSchema.parse(JSON.parse((await readBoundedWorkspaceFile(file, 16 * 1024, io)).toString('utf8')))
}

/** 扫描归属记录而非 SKILL.md，本机或远端正文已被删除的副本仍然可以清理。 */
export async function managedSkills(io: SkillWorkspaceIO, home: string): Promise<ManagedSkill[]> {
  const root = skillRoot(io, home)
  if (!await ordinaryDirectory(io, root)) return []
  const queue = [{ id: '', path: root, depth: 0 }]
  const result: ManagedSkill[] = []
  let entries = 0
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]!
    if (current.id) {
      const marker = await markerAt(io, current.path).catch(error => {
        if (isStaging(current.id) && (error instanceof SyntaxError || error instanceof z.ZodError)) return null
        throw error
      })
      if (marker) {
        try { result.push({ id: current.id, marker, modified: await skillTreeDigest(io, current.path) !== marker.digest }) }
        catch (error) { result.push({ id: current.id, marker, modified: true, error: error instanceof Error ? error.message : String(error) }) }
        continue
      }
      if (isStaging(current.id)) {
        result.push({ id: current.id, marker: null, modified: true, error: '未完成的 Skill 操作，清理前需要确认' })
        continue
      }
      if (await exists(io.fs, io.path.join(current.path, 'SKILL.md'))) continue
    }
    for (const entry of await io.fs.readdir(current.path, { withFileTypes: true })) {
      if (++entries > 2000) throw new Error('远端 Skill 目录超过 2000 项，无法完整核对，请精简后重试')
      if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.name.startsWith('.') && !(current.depth === 0 && (entry.name === '.system' || isStaging(entry.name))))) continue
      if (current.depth >= 6) continue
      const id = current.id ? `${current.id}/${entry.name}` : entry.name
      const directory = skillPath(root, id, io.path)
      if (await ordinaryDirectory(io, directory)) queue.push({ id, path: directory, depth: current.depth + 1 })
    }
  }
  return result
}

export async function publishSkill(io: SkillWorkspaceIO, home: string, id: string, tree: SkillTree, metadata: Pick<SkillMarker, 'name' | 'description'>, previous?: string): Promise<void> {
  const root = skillRoot(io, home)
  const destination = skillPath(root, id, io.path)
  await ordinaryDirectory(io, io.path.dirname(destination), true)
  const staging = temporaryPath(io, home)
  const backup = temporaryPath(io, home)
  let moved = false
  let published = false
  await io.fs.mkdir(staging, { mode: 0o700 })
  try {
    await io.fs.writeFile(io.path.join(staging, SKILL_SYNC_MARKER), JSON.stringify({ owner: 'whycode-skill-sync', name: metadata.name, description: metadata.description, digest: tree.digest }), { flag: 'wx', mode: 0o600 })
    // 同层目录及文件有界并发，VPN 下不让每个资源都串行等待一个往返。
    for (const depth of [...new Set(tree.directories.map(value => value.split('/').length))].sort((a, b) => a - b)) {
      await mapSkillFiles(tree.directories.filter(value => value.split('/').length === depth), directory => io.fs.mkdir(io.path.join(staging, directory), { mode: 0o700 }))
    }
    await mapSkillFiles(tree.files, file => io.fs.writeFile(io.path.join(staging, file.path), file.data, { flag: 'wx', mode: file.mode }))
    if (previous) {
      const marker = await markerAt(io, destination)
      if (!marker || marker.digest !== previous || await skillTreeDigest(io, destination) !== previous) throw new Error('远端 Skill 已变化，保留现有内容，请重新查看')
      await io.fs.rename(destination, backup); moved = true
    } else if (await exists(io.fs, destination)) throw new Error('远端目录已存在，未覆盖任何文件')
    await io.fs.rename(staging, destination); published = true
    if (moved) await io.fs.rm(backup, { recursive: true })
  } catch (error) {
    if (moved && !published && !await exists(io.fs, destination)) await io.fs.rename(backup, destination)
    throw error
  } finally {
    // 只删除本次创建的暂存路径；中断后仍可通过归属扫描列出并清理残留。
    if (await exists(io.fs, staging)) await io.fs.rm(staging, { recursive: true })
    if (!published) await pruneEmptyParents(io, io.path.dirname(destination), home)
  }
}

export async function cleanManagedSkills(io: SkillWorkspaceIO, home: string, options: SshReleaseOptions, ids?: string[], progress?: (result: SshSkillResult) => void): Promise<SshSkillResult[]> {
  const all = await managedSkills(io, home)
  const selected = ids ? ids.map(id => {
    const entry = all.find(item => item.id === id)
    if (!entry) throw new Error(`Skill 不属于 WhyCode 同步副本：${id}`)
    return entry
  }) : all
  const modified = selected.filter(item => item.modified && !options.allowModified?.includes(item.id) && !options.keepModified?.includes(item.id))
  if (modified.length) throw new ModifiedSshSkillsError(modified.map(item => item.id))
  const results: SshSkillResult[] = []
  const root = skillRoot(io, home)
  for (const entry of selected) {
    let result: SshSkillResult
    const name = entry.marker?.name ?? '未完成的 Skill 操作'
    try {
      if (entry.modified && options.keepModified?.includes(entry.id)) {
        result = { id: entry.id, name, ok: true, message: '已保留远端修改', preserved: true }
        results.push(result); progress?.(result); continue
      }
      const directory = skillPath(root, entry.id, io.path)
      await ordinaryDirectory(io, directory)
      const marker = entry.marker ? await markerAt(io, directory) : null
      if (entry.marker ? !marker || marker.digest !== entry.marker.digest : !isStaging(entry.id)) throw new Error('Skill 归属记录已变化，请重试')
      if (!options.allowModified?.includes(entry.id) && await skillTreeDigest(io, directory) !== marker?.digest) throw new Error('Skill 在服务器上有新的修改，未删除')
      // 先退到专用临时目录；递归删除中断、归属文件已移除时仍有可核对的清理入口。
      const deleting = isStaging(entry.id) ? directory : temporaryPath(io, home)
      if (deleting !== directory) {
        await io.fs.rename(directory, deleting)
        await pruneEmptyParents(io, io.path.dirname(directory), home)
      }
      await io.fs.rm(deleting, { recursive: true })
      result = { id: entry.id, name, ok: true, message: '已清理' }
    } catch (error) { result = { id: entry.id, name, ok: false, message: error instanceof Error ? error.message : String(error) } }
    results.push(result); progress?.(result)
  }
  await pruneEmptyParents(io, root, home)
  return results
}
