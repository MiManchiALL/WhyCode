import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { z } from 'zod'
import type { WorkspaceFileSystem } from '@whycode/core'

const OWNER = 'WhyCode remote process host v1\n'
export const ENVIRONMENT_OWNER = 'WhyCode workspace dependencies v1\n'
export interface RemoteComponent { directory: string; identity: string }

export async function readComponentIdentity(fs: WorkspaceFileSystem, directory: string): Promise<string | null> {
  const parent = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
  if (!parent) return null
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('远端组件目录归属校验失败')
  const file = posix.join(directory, '.identity')
  const info = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
  if (!info) return null
  if (!info.isFile() || info.size > 64) throw new Error('远端组件身份文件无效，已保留目录')
  const identity = z.uuid().safeParse((await fs.readFile(file, 'utf8')).trim())
  if (!identity.success) throw new Error('远端组件身份文件无效或正在初始化，请稍后重试')
  return identity.data
}

export async function prepareRemoteComponent(fs: WorkspaceFileSystem, home: string): Promise<RemoteComponent> {
  const directory = posix.join(home, '.cache', 'whycode-remote')
  await fs.mkdir(directory, { recursive: true })
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('远端组件目录不能是符号链接')
  const ownerPath = posix.join(directory, '.owner')
  const ownerInfo = await fs.lstat(ownerPath).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
  if (ownerInfo && !ownerInfo.isFile()) throw new Error('远端组件归属文件不是普通文件')
  let owner = await fs.readFile(ownerPath, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
  if (owner === null) {
    if ((await fs.readdir(directory, { withFileTypes: true })).length) throw new Error('远端缓存目录已被占用')
    await fs.writeFile(ownerPath, OWNER, { flag: 'wx', mode: 0o600 })
    owner = OWNER
  }
  if (owner !== OWNER) throw new Error('远端组件目录归属校验失败')
  const existing = await readComponentIdentity(fs, directory)
  if (existing) return { directory, identity: existing }
  const identity = randomUUID()
  try { await fs.writeFile(posix.join(directory, '.identity'), `${identity}\n`, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    // 不覆盖另一个入口刚创建的身份，也不把未写完的标记当成另一份组件。
    const concurrent = await readComponentIdentity(fs, directory)
    if (!concurrent) throw error
    return { directory, identity: concurrent }
  }
  return { directory, identity }
}

/** Only known component files are removed; unknown contents, projects and scratch are untouched. */
export async function cleanupRemoteComponent(fs: WorkspaceFileSystem, directory: string, removeEnvironment: (directory: string) => Promise<void>): Promise<void> {
  const info = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
  if (!info) return
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('远端组件目录归属校验失败')
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const unknown = entries.some(entry => entry.name === 'office'
    ? !entry.isDirectory() || entry.isSymbolicLink()
    : !entry.isFile() || (!['.owner', '.identity'].includes(entry.name) && !/^(?:host|rg)-[0-9a-f]{64}$/u.test(entry.name)))
  if (unknown) throw new Error('组件目录包含未知文件，已保留目录')
  const owner = posix.join(directory, '.owner')
  if (await fs.readFile(owner, 'utf8') !== OWNER) throw new Error('远端组件目录归属校验失败')
  await readComponentIdentity(fs, directory)
  if (entries.some(entry => entry.name === 'office')) {
    const environment = posix.join(directory, 'office')
    const marker = posix.join(environment, '.owner')
    const metadata = await fs.lstat(marker)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 128 || await fs.readFile(marker, 'utf8') !== ENVIRONMENT_OWNER) throw new Error('远端 Office 环境归属校验失败，已保留目录')
    await removeEnvironment(environment)
  }
  for (const entry of entries) if (!['.owner', '.identity', 'office'].includes(entry.name)) await fs.unlink(posix.join(directory, entry.name))
  await fs.unlink(owner)
  // 身份最后删除；归属标记已移除时，新入口不能给正在清理的目录创建新身份。
  if (entries.some(entry => entry.name === '.identity')) await fs.unlink(posix.join(directory, '.identity'))
  await fs.rmdir(directory)
}
