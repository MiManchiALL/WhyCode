import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { ModelMessage } from 'ai'
import { findProjectRoot } from '../project-root.ts'

const PROJECT_INSTRUCTIONS_RE = /^<system-reminder>\n<whycode-project-instructions version="(sha256:[a-f0-9]{64})">\n([\s\S]*)\n<\/whycode-project-instructions>\n<\/system-reminder>$/
const DEFAULT_MAX_CONTENT_BYTES = 32 * 1024

interface InstructionSource {
  path: string
  content: string
}

export interface ProjectInstructionsSnapshot {
  version: string
  message: ModelMessage
}

export interface ProjectInstructionsUpdate {
  version: string | null
  message: ModelMessage | null
}

export async function loadProjectInstructions(
  input: {
    homeDir?: string
    projectDir: string | null
    maxContentBytes?: number
  },
): Promise<ProjectInstructionsSnapshot | null> {
  const sources: InstructionSource[] = []
  if (input.homeDir) {
    const global = await readOptionalFile(join(resolve(input.homeDir), '.whycode', 'AGENTS.md'))
    if (global !== null) sources.push(global)
  }
  if (input.projectDir) {
    const selectedDir = resolve(input.projectDir)
    const projectRoot = await findProjectRoot(selectedDir)
    for (const directory of directoriesBetween(projectRoot, selectedDir)) {
      const source = await readDirectoryInstructions(directory)
      if (source) sources.push(source)
    }
  }
  if (sources.length === 0) return null

  const body = renderSources(
    sources,
    input.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES,
  )
  const version = hash(body)
  return {
    version,
    message: {
      role: 'user',
      content: [
        '<system-reminder>',
        `<whycode-project-instructions version="${version}">`,
        body,
        '</whycode-project-instructions>',
        '</system-reminder>',
      ].join('\n'),
    },
  }
}

export function projectInstructionsVersion(message: ModelMessage): string | null {
  if (message.role !== 'user' || typeof message.content !== 'string') return null
  const match = PROJECT_INSTRUCTIONS_RE.exec(message.content)
  if (!match || hash(match[2]!) !== match[1]) return null
  return match[1]
}

export function isProjectInstructionsMessage(message: ModelMessage): boolean {
  return projectInstructionsVersion(message) !== null
}

export function findProjectInstructionsMessage(
  messages: readonly ModelMessage[],
): ModelMessage | null {
  return messages.find(isProjectInstructionsMessage) ?? null
}

export function applyProjectInstructions(
  messages: readonly ModelMessage[],
  instruction: ModelMessage | null,
): ModelMessage[] {
  const conversation = messages.filter((message) => !isProjectInstructionsMessage(message))
  return instruction ? [instruction, ...conversation] : conversation
}

export function projectInstructionsUpdate(
  currentMessages: readonly ModelMessage[],
  snapshot: ProjectInstructionsSnapshot | null,
): ProjectInstructionsUpdate | null {
  const current = findProjectInstructionsMessage(currentMessages)
  const currentVersion = current ? projectInstructionsVersion(current) : null
  const desiredVersion = snapshot?.version ?? null
  return currentVersion === desiredVersion
    ? null
    : {
        version: desiredVersion,
        message: snapshot?.message ?? null,
      }
}

export function validateProjectInstructionsUpdate(
  update: ProjectInstructionsUpdate,
): boolean {
  return update.message === null
    ? update.version === null
    : update.version !== null
      && projectInstructionsVersion(update.message) === update.version
}

async function readDirectoryInstructions(directory: string): Promise<InstructionSource | null> {
  const override = await readOptionalFile(join(directory, 'AGENTS.override.md'))
  if (override !== null) return override
  return readOptionalFile(join(directory, 'AGENTS.md'))
}

async function readOptionalFile(path: string): Promise<InstructionSource | null> {
  try {
    return { path, content: await readFile(path, 'utf8') }
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

function directoriesBetween(root: string, leaf: string): string[] {
  const directories: string[] = []
  let current = leaf
  while (true) {
    directories.push(current)
    if (current === root) return directories.reverse()
    const parent = dirname(current)
    if (parent === current) return [leaf]
    current = parent
  }
}

function renderSources(sources: InstructionSource[], maxContentBytes: number): string {
  if (!Number.isSafeInteger(maxContentBytes) || maxContentBytes < 0) {
    throw new Error('项目指令内容上限必须是非负安全整数')
  }
  let remaining = maxContentBytes
  const rendered = new Array<string>(sources.length)
  for (let index = sources.length - 1; index >= 0; index--) {
    const source = sources[index]!
    const byteLength = Buffer.byteLength(source.content, 'utf8')
    const content = byteLength <= remaining
      ? source.content
      : utf8Prefix(source.content, remaining)
    remaining -= Buffer.byteLength(content, 'utf8')
    const renderedContent = source.content.length === 0
      ? '[文件为空]'
      : content.length === 0
        ? '[内容因项目指令总上限而省略]'
        : content.length === source.content.length
          ? content
          : `${content}\n[内容因项目指令总上限而截断]`
    rendered[index] = [
      `## Source: ${source.path}`,
      renderedContent,
    ].join('\n')
  }
  return [
    '以下是 WhyCode 从全局和当前项目发现的指令。直接用户要求优先；同目录 override 优先，目录越深优先级越高。',
    ...rendered,
  ].join('\n\n')
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  let bytes = 0
  let result = ''
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8')
    if (bytes + size > maxBytes) break
    result += character
    bytes += size
  }
  return result
}

function hash(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR'),
  )
}
