import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { EMBEDDED_SYSTEM_SKILL_FILES } from './system-assets.ts'

export const SYSTEM_SKILLS_MARKER_FILE = '.whycode-system-skills.marker'
const SYSTEM_SKILLS_DIRECTORY = '.system'
const INSTALLING_DIRECTORY = '.system.installing'
const FINGERPRINT_SALT = 'whycode-system-skills-v1'

export interface SystemSkillsInstallResult {
  rootPath: string
  fingerprint: string
  changed: boolean
}

export function systemSkillsRoot(homeDir: string): string {
  return join(resolve(homeDir), '.whycode', 'skills', SYSTEM_SKILLS_DIRECTORY)
}

/**
 * 把随应用发布的 Skill 物化为可由统一磁盘读取链路消费的托管缓存。
 * `.system` 只存应用资产；指纹变化时整目录替换，用户 Skill 始终留在 `.agents`。
 */
export async function installSystemSkills(homeDir: string): Promise<SystemSkillsInstallResult> {
  const home = resolve(homeDir)
  await requireOrdinaryDirectory(home, '用户主目录')
  const whycodeDirectory = await ensureChildDirectory(home, '.whycode')
  const skillsDirectory = await ensureChildDirectory(whycodeDirectory, 'skills')
  const target = join(skillsDirectory, SYSTEM_SKILLS_DIRECTORY)
  const fingerprint = systemSkillsFingerprint()
  if (await markerMatches(target, fingerprint)) {
    return { rootPath: target, fingerprint, changed: false }
  }

  const staging = join(skillsDirectory, INSTALLING_DIRECTORY)
  await removeManagedDirectory(staging, 'Skill 安装暂存目录')
  await mkdir(staging, { mode: 0o700 })
  try {
    for (const asset of EMBEDDED_SYSTEM_SKILL_FILES) {
      const relativePath = validateAssetPath(asset.relativePath)
      const destination = resolve(staging, relativePath)
      if (!isInside(staging, destination)) throw new Error(`内置 Skill 路径越界：${relativePath}`)
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      await writeFile(destination, asset.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    }
    await writeFile(join(staging, SYSTEM_SKILLS_MARKER_FILE), `${fingerprint}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    await removeManagedDirectory(target, '内置 Skill 目录')
    await rename(staging, target)
  } catch (error) {
    await removeManagedDirectory(staging, 'Skill 安装暂存目录').catch(() => {})
    throw error
  }
  return { rootPath: target, fingerprint, changed: true }
}

function systemSkillsFingerprint(): string {
  const hash = createHash('sha256').update(FINGERPRINT_SALT, 'utf8')
  for (const asset of [...EMBEDDED_SYSTEM_SKILL_FILES]
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'))) {
    hash.update('\0').update(asset.relativePath, 'utf8').update('\0').update(asset.content, 'utf8')
  }
  return `sha256:${hash.digest('hex')}`
}

async function markerMatches(target: string, fingerprint: string): Promise<boolean> {
  const targetInfo = await metadata(target)
  if (!targetInfo) return false
  if (targetInfo.isSymbolicLink() || !targetInfo.isDirectory()) {
    throw new Error('内置 Skill 目标必须是普通目录且不能是符号链接')
  }
  const marker = join(target, SYSTEM_SKILLS_MARKER_FILE)
  const markerInfo = await metadata(marker)
  if (!markerInfo) return false
  if (markerInfo.isSymbolicLink() || !markerInfo.isFile() || markerInfo.size > 256) return false
  return (await readFile(marker, 'utf8')).trim() === fingerprint
}

async function ensureChildDirectory(parent: string, name: string): Promise<string> {
  const path = join(parent, name)
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if (!isAlreadyExists(error)) throw error
  }
  await requireOrdinaryDirectory(path, name)
  return path
}

async function requireOrdinaryDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label}必须是普通目录且不能是符号链接`)
  }
}

async function removeManagedDirectory(path: string, label: string): Promise<void> {
  const info = await metadata(path)
  if (!info) return
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label}必须是普通目录且不能是符号链接`)
  }
  await rm(path, { recursive: true })
}

function validateAssetPath(value: string): string {
  const normalized = value.replaceAll('\\', '/')
  const segments = normalized.split('/')
  if (
    isAbsolute(value)
    || /^[A-Za-z]:/.test(normalized)
    || segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`内置 Skill 资源路径无效：${value}`)
  }
  return segments.join('/')
}

function isInside(rootPath: string, candidatePath: string): boolean {
  const path = relative(rootPath, candidatePath)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

async function metadata(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')
}
