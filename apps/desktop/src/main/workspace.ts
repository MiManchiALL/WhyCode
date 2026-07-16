import { mkdir, realpath, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const DEFAULT_WORKSPACE_NAME = 'WhyCode Workspace'

/**
 * 首次启动即提供一个真实、可写的工作目录；Documents 不可用时退回应用私有目录。
 * 返回规范化绝对路径，确保工具、命令 cwd 与界面展示引用同一事实。
 */
export async function ensureDefaultWorkspace(
  documentsDirectory: string,
  userDataDirectory: string,
): Promise<string> {
  const preferred = join(resolve(documentsDirectory), DEFAULT_WORKSPACE_NAME)
  try {
    return await ensureDirectory(preferred)
  } catch (preferredError) {
    const fallback = join(resolve(userDataDirectory), 'workspace')
    try {
      return await ensureDirectory(fallback)
    } catch (fallbackError) {
      throw new AggregateError(
        [preferredError, fallbackError],
        '无法创建 WhyCode 默认工作文件夹',
      )
    }
  }
}

async function ensureDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await stat(path)
  if (!info.isDirectory()) throw new Error(`默认工作路径不是文件夹：${path}`)
  return realpath(path)
}
