import { createHash } from 'node:crypto'
import { basename, dirname, resolve } from 'node:path'
import { parseDocument } from 'yaml'
import {
  SKILL_MAX_DESCRIPTION_CHARS,
  SKILL_MAX_DOCUMENT_BYTES,
  SKILL_MAX_NAME_CHARS,
  SKILL_NAME_PATTERN,
  type ActivatedSkill,
  type SkillScope,
} from './types.ts'

const FRONTMATTER_RE = /^---[\t ]*\r?\n([\s\S]*?)\r?\n---[\t ]*(?:\r?\n|$)/

export interface ParseSkillInput {
  path: string
  scope: SkillScope
  content: string
}

export function parseSkillDocument(input: ParseSkillInput): ActivatedSkill {
  const path = resolve(input.path)
  const content = input.content.replace(/^\uFEFF/, '')
  const byteLength = Buffer.byteLength(content, 'utf8')
  if (byteLength > SKILL_MAX_DOCUMENT_BYTES) {
    throw new Error(`SKILL.md 超过 ${SKILL_MAX_DOCUMENT_BYTES} 字节上限`)
  }
  const frontmatter = FRONTMATTER_RE.exec(content)
  if (!frontmatter) throw new Error('缺少以 --- 包围的 YAML frontmatter')

  const document = parseDocument(frontmatter[1]!, {
    prettyErrors: false,
    uniqueKeys: true,
  })
  if (document.errors.length > 0) {
    throw new Error(`YAML 无效：${document.errors[0]!.message}`)
  }
  const metadata = document.toJS() as unknown
  if (!isPlainObject(metadata)) throw new Error('YAML frontmatter 必须是对象')

  const name = requiredString(metadata, 'name')
  const description = requiredString(metadata, 'description')
  if (name.length > SKILL_MAX_NAME_CHARS || !SKILL_NAME_PATTERN.test(name)) {
    throw new Error('name 必须为不超过 64 个字符的小写字母、数字和单连字符组合')
  }
  const packageName = basename(dirname(path))
  if (packageName !== name) throw new Error(`name 必须与目录名一致（当前目录：${packageName}）`)
  if (description.length > SKILL_MAX_DESCRIPTION_CHARS) {
    throw new Error(`description 超过 ${SKILL_MAX_DESCRIPTION_CHARS} 个字符`)
  }

  const rootPath = dirname(path)
  return {
    id: skillId(path),
    path,
    rootPath,
    name,
    description,
    scope: input.scope,
    digest: skillContentDigest(content),
    content,
  }
}

export function skillId(path: string): string {
  const normalized = process.platform === 'win32'
    ? resolve(path).replaceAll('\\', '/').toLowerCase()
    : resolve(path)
  return `skill:${createHash('sha256').update(normalized, 'utf8').digest('hex')}`
}

export function skillContentDigest(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string' || !field.trim()) throw new Error(`${key} 必须是非空字符串`)
  return field.trim()
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
