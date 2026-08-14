import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 把普通目录内容复制到已创建的空目标目录。链接和特殊文件会保留共享或设备语义，
 * 与独立快照冲突，因此遇到它们时终止整个事务。
 */
export async function copyDirectorySnapshot(
  sourceRoot: string,
  targetRoot: string,
): Promise<void> {
  await assertOrdinaryDirectory(sourceRoot)
  await assertOrdinaryDirectory(targetRoot)
  await copyDirectoryContents(sourceRoot, targetRoot)
}

async function copyDirectoryContents(source: string, target: string): Promise<void> {
  const names = await readdir(source)
  for (const name of names) {
    const sourcePath = join(source, name)
    const targetPath = join(target, name)
    const info = await lstat(sourcePath)
    if (info.isSymbolicLink()) {
      throw new Error(`目录快照不支持符号链接或目录联接：${sourcePath}`)
    }
    if (info.isDirectory()) {
      await mkdir(targetPath, { mode: 0o700 })
      await copyDirectoryContents(sourcePath, targetPath)
      continue
    }
    if (!info.isFile()) {
      throw new Error(`目录快照只支持普通文件和目录：${sourcePath}`)
    }
    await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL)
  }
}

async function assertOrdinaryDirectory(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`目录快照路径不是普通目录：${path}`)
  }
}
