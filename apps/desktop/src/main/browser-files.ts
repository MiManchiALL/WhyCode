import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BROWSER_FILE_SCHEME, browserDisplayUrl, isBrowserUrl } from '../shared/browser.ts'
import { containsPath, pathKey } from './workspace-path.ts'

interface DirectoryGrant { root: string; owners: Set<string> }
const MAX_DIRECTORIES_PER_TAB = 32

/** 本机地址只由宿主输入授予；网页相对资源不能越过已打开目录。 */
export class BrowserFiles {
  private readonly directories = new Map<string, DirectoryGrant>()

  open(owner: string, value: string): string {
    if (!isBrowserUrl(value) || new URL(value).protocol !== 'file:') throw new Error('本机文件地址无效')
    const root = pathKey(dirname(fileURLToPath(value)))
    // 目录的 origin 稳定，刷新和重新打开文件沿用该目录的网页存储。
    const id = createHash('sha256').update(root).digest('hex')
    let grant = this.directories.get(id)
    if (!grant?.owners.has(owner)
      && [...this.directories.values()].filter(item => item.owners.has(owner)).length >= MAX_DIRECTORIES_PER_TAB) {
      throw new Error('此标签打开的本机目录过多，请新建浏览器标签')
    }
    if (!grant) { grant = { root, owners: new Set() }; this.directories.set(id, grant) }
    grant.owners.add(owner)
    const url = new URL(value)
    return `${BROWSER_FILE_SCHEME}://${id}${url.pathname}${url.search}${url.hash}`
  }

  allows(owner: string, value: string): boolean {
    try {
      const url = new URL(value)
      const grant = this.directories.get(url.hostname)
      return url.protocol === `${BROWSER_FILE_SCHEME}:` && !url.username && !url.password && !url.port
        && !!grant?.owners.has(owner) && containsPath(grant.root, fileURLToPath(browserDisplayUrl(value)))
    } catch { return false }
  }

  async resolve(value: string): Promise<string> {
    const url = new URL(value)
    const grant = this.directories.get(url.hostname)
    if (!grant || ![...grant.owners].some(owner => this.allows(owner, value))) throw new Error('本机目录未打开')
    const [root, path] = await Promise.all([realpath(grant.root), realpath(fileURLToPath(browserDisplayUrl(value)))])
    if (!containsPath(root, path) || !(await stat(path)).isFile()
      || this.directories.get(url.hostname) !== grant) throw new Error('文件不在已打开目录中')
    return path
  }

  release(owner: string): void {
    for (const [id, grant] of this.directories) {
      grant.owners.delete(owner)
      if (!grant.owners.size) this.directories.delete(id)
    }
  }
}
