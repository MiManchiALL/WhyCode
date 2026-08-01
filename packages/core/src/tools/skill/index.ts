import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { findSuspiciousWindowsPattern } from '../../permissions/path-safety.ts'
import {
  SKILL_FILE_NAME,
  SKILL_MAX_RESOURCE_BYTES,
  type SkillTurnSnapshot,
} from '../../skills/types.ts'
import { readBoundedSkillFile } from '../../skills/read.ts'
import { escapeSkillXmlAttribute } from '../../skills/xml.ts'
import { buildTool } from '../tool.ts'
import { SKILL_TOOL_PROMPT } from './prompt.ts'

export const SKILL_TOOL_NAME = 'Skill'

const skillInputSchema = z.object({
  skillId: z.string().regex(/^skill:[a-f0-9]{64}$/)
    .describe('当前 available_skills 目录中的精确 Skill id'),
  resourcePath: z.string().min(1).max(1_024).optional()
    .describe('可选的 Skill 包内 UTF-8 文本资源相对路径；省略时读取冻结的 SKILL.md'),
}).strict()

export function createSkillTool(snapshot: SkillTurnSnapshot) {
  return buildTool({
    name: SKILL_TOOL_NAME,
    description: '读取当前任务可用的 Skill 指令或包内文本资源',
    prompt: SKILL_TOOL_PROMPT,
    inputSchema: skillInputSchema,
    isReadOnly: true,
    kind: 'read',
    availableWithoutProject: true,
    async execute(input) {
      const skill = snapshot.entries.find((entry) => entry.id === input.skillId)
      if (!skill) return { data: 'Skill 不在当前根任务的目录快照中', isError: true }
      try {
        const resourcePath = normalizeResourcePath(input.resourcePath ?? SKILL_FILE_NAME)
        if (resourcePath === SKILL_FILE_NAME) {
          return {
            data: renderSkillResource(skill.name, SKILL_FILE_NAME, skill.content),
            isError: false,
          }
        }
        const content = await readSkillResource(skill.rootPath, resourcePath)
        return { data: renderSkillResource(skill.name, resourcePath, content), isError: false }
      } catch (error) {
        return {
          data: error instanceof Error ? error.message : String(error),
          isError: true,
        }
      }
    },
  })
}

async function readSkillResource(rootPath: string, resourcePath: string): Promise<string> {
  const candidate = resolve(rootPath, resourcePath)
  const rootMetadata = await lstat(rootPath)
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error('Skill 包根目录已被符号链接或目录联接替换')
  }
  await rejectSymbolicLinkSegments(rootPath, resourcePath)
  const root = await realpath(rootPath)
  const resolved = await realpath(candidate)
  if (!isInside(root, resolved)) throw new Error('resourcePath 越过 Skill 包根目录')
  const metadata = await lstat(resolved)
  if (!metadata.isFile()) throw new Error('resourcePath 必须指向普通文件')
  if (metadata.size > SKILL_MAX_RESOURCE_BYTES) {
    throw new Error(`Skill 资源超过 ${SKILL_MAX_RESOURCE_BYTES} 字节上限`)
  }
  const bytes = await readBoundedSkillFile(resolved, SKILL_MAX_RESOURCE_BYTES)
  if (bytes.includes(0)) throw new Error('Skill 资源不是文本文件')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('Skill 资源必须是有效 UTF-8 文本')
  }
}

function normalizeResourcePath(resourcePath: string): string {
  const normalized = resourcePath.replaceAll('\\', '/')
  if (isAbsolute(resourcePath) || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error('resourcePath 必须是 Skill 包内相对路径')
  }
  const segments = normalized.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('resourcePath 不能包含空路径段、. 或 ..')
  }
  if (process.platform === 'win32') {
    const suspicious = findSuspiciousWindowsPattern(resourcePath)
    if (suspicious) throw new Error(`resourcePath 包含不安全的 Windows 路径：${suspicious}`)
  }
  return segments.join('/')
}

async function rejectSymbolicLinkSegments(rootPath: string, resourcePath: string): Promise<void> {
  let current = rootPath
  for (const segment of resourcePath.split('/')) {
    current = join(current, segment)
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error('resourcePath 不能经过符号链接或目录联接')
    }
  }
}

function isInside(rootPath: string, candidatePath: string): boolean {
  const path = relative(rootPath, candidatePath)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function renderSkillResource(skillName: string, path: string, content: string): string {
  return [
    `<skill-resource name="${escapeSkillXmlAttribute(skillName)}" path="${escapeSkillXmlAttribute(path)}" current-root-task-only="true">`,
    content,
    '</skill-resource>',
  ].join('\n')
}
