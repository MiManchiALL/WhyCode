import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  CUSTOM_SYSTEM_PROMPT_MAX_BYTES,
  customSystemPromptSnapshotSchema,
  type CustomSystemPromptSnapshot,
} from '@whycode/core'

const CUSTOM_SYSTEM_PROMPT_CONFIG_NAME = 'system-prompt.json'
const DEFAULT_CUSTOM_SYSTEM_PROMPT_FILE = 'SYSTEM.md'
const CUSTOM_SYSTEM_PROMPT_CONFIG_MAX_BYTES = 16 * 1024
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u

interface CustomSystemPromptFileConfig {
  mode: 'off' | CustomSystemPromptSnapshot['mode']
  file: string
}

const DEFAULT_CONFIG: CustomSystemPromptFileConfig = {
  mode: 'off',
  file: DEFAULT_CUSTOM_SYSTEM_PROMPT_FILE,
}

/** 自定义 System 与应用托管的凭据配置同目录，但拥有独立、可人工编辑的事实源。 */
export function getCustomSystemPromptConfigPath(appConfigPath: string): string {
  return join(dirname(appConfigPath), CUSTOM_SYSTEM_PROMPT_CONFIG_NAME)
}

/**
 * 首次安装只生成一份关闭状态的模板。已有配置或正文永不改写；
 * 因此升级和用户编辑不会被启动流程覆盖。
 */
export async function ensureCustomSystemPromptTemplate(
  configPath: string,
): Promise<boolean> {
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 })
  const created = await writeNewFile(
    configPath,
    `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`,
  )
  if (!created) return false
  try {
    await writeNewFile(
      join(dirname(configPath), DEFAULT_CUSTOM_SYSTEM_PROMPT_FILE),
      '',
    )
    return true
  } catch (error) {
    // 配置是本次刚创建的；正文模板失败时回滚，避免留下无法完成初始化的半状态。
    await rm(configPath, { force: true }).catch(() => {})
    throw error
  }
}

export async function loadCustomSystemPromptSnapshot(
  configPath: string,
): Promise<CustomSystemPromptSnapshot | undefined> {
  const configBytes = await readOptionalFile(configPath)
  if (!configBytes) return undefined
  if (configBytes.length > CUSTOM_SYSTEM_PROMPT_CONFIG_MAX_BYTES) {
    throw new Error(
      `自定义 System 配置超过 ${CUSTOM_SYSTEM_PROMPT_CONFIG_MAX_BYTES} 字节上限：${configPath}`,
    )
  }

  const configText = decodeUtf8(
    configBytes,
    `自定义 System 配置不是有效的 UTF-8 文本：${configPath}`,
  )
  const config = parseConfig(configText, configPath)
  if (config.mode === 'off') return undefined

  const filePath = isAbsolute(config.file)
    ? resolve(config.file)
    : resolve(dirname(configPath), config.file)
  let bytes: Buffer
  try {
    bytes = await readFile(filePath)
  } catch (error) {
    throw new Error(
      `无法读取自定义 System 文件 ${filePath}：${errorMessage(error)}`,
    )
  }
  if (bytes.length > CUSTOM_SYSTEM_PROMPT_MAX_BYTES) {
    throw new Error(
      `自定义 System 文件超过 ${CUSTOM_SYSTEM_PROMPT_MAX_BYTES} 字节上限：${filePath}`,
    )
  }

  const content = decodeUtf8(
    bytes,
    `自定义 System 文件不是有效的 UTF-8 文本：${filePath}`,
  )
  const parsed = customSystemPromptSnapshotSchema.safeParse({
    mode: config.mode,
    content,
  })
  if (!parsed.success) {
    throw new Error(`自定义 System 文件不能为空：${filePath}`)
  }
  return parsed.data
}

function parseConfig(text: string, configPath: string): CustomSystemPromptFileConfig {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(
      `自定义 System 配置不是有效的 JSON：${configPath}：${errorMessage(error)}`,
    )
  }
  if (!isRecord(value)) throw invalidConfig(configPath)
  const keys = Object.keys(value)
  if (
    keys.length !== 2
    || !keys.includes('mode')
    || !keys.includes('file')
    || (
      value.mode !== 'off'
      && value.mode !== 'append'
      && value.mode !== 'replace'
    )
    || typeof value.file !== 'string'
  ) {
    throw invalidConfig(configPath)
  }
  const file = value.file.trim()
  if (!file || file.length > 4_096 || CONTROL_CHARACTER.test(file)) {
    throw invalidConfig(configPath)
  }
  return { mode: value.mode, file }
}

async function readOptionalFile(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw new Error(
      `无法读取自定义 System 配置 ${path}：${errorMessage(error)}`,
    )
  }
}

async function writeNewFile(path: string, content: string): Promise<boolean> {
  try {
    await writeFile(path, content, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
      flush: true,
    })
    return true
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false
    throw error
  }
}

function decodeUtf8(bytes: Buffer, error: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(error)
  }
}

function invalidConfig(path: string): Error {
  return new Error(
    `自定义 System 配置格式错误：${path}；只允许 mode=off|append|replace 和非空 file`,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String(error.code)
    : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
