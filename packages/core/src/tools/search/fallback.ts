import ignore from 'ignore'
import { Minimatch } from 'minimatch'
import { localWorkspaceIO, type WorkspaceDirent, type WorkspaceIO } from '../../workspace/io.ts'
import { readBoundedWorkspaceFile } from '../../workspace/read.ts'
import { IGNORED_DIRS } from '../fs-utils.ts'
import type { ToolContext } from '../tool.ts'

export function fileGlob(pattern: string): Minimatch {
  const path = pattern.replaceAll('\\', '/')
  return new Minimatch(path.replace(/^(?:\.\/|\/)/, ''), {
    platform: 'linux', dot: true, matchBase: !path.includes('/'), noext: true, nonegate: true, nocomment: true,
    braceExpandMax: 1_000,
  })
}

interface IgnoreFile {
  directory: string
  priority: number
  rules: ReturnType<typeof ignore>
}

const IGNORE_FILES = ['.git/info/exclude', '.gitignore', '.ignore', '.rgignore']

async function directoryRules(io: WorkspaceIO, directory: string, inherited: IgnoreFile[], entries: WorkspaceDirent[], signal: AbortSignal): Promise<IgnoreFile[]> {
  const found: IgnoreFile[] = []
  for (const [priority, name] of IGNORE_FILES.entries()) {
    const present = priority === 0
      ? entries.some(entry => entry.name === '.git' && entry.isDirectory())
      : entries.some(entry => entry.name === name && entry.isFile())
    if (!present) continue
    const path = io.path.join(directory, name)
    const bytes = await readBoundedWorkspaceFile(path, 2 * 1024 * 1024, io, signal).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (bytes) found.push({ directory, priority, rules: ignore({ ignorecase: false }).add(bytes.toString('utf8')) })
  }
  // .rgignore 优先于 .ignore 和 Git 规则；同类文件以最近的目录为准。
  return found.length ? [...found, ...inherited].sort((a, b) => b.priority - a.priority) : inherited
}

export interface ScanStatus { limited: boolean; unreadable: number }

export function incompleteScan(scan: ScanStatus, large = 0): string | undefined {
  const reasons: string[] = []
  if (large) reasons.push(`${large} 个文件超过 2 MiB`)
  if (scan.unreadable) reasons.push(`${scan.unreadable} 项不可读取`)
  if (scan.limited) reasons.push('达到遍历上限，请缩小 path')
  return reasons.length ? `搜索不完整：${reasons.join('，')}` : undefined
}

/** 按目录排序遍历。启用忽略规则时，子目录搜索也继承项目内上层目录的规则。 */
export async function* walkSearchFiles(root: string, gitignore: boolean, status: ScanStatus, ctx: ToolContext): AsyncGenerator<string> {
  const { projectDir, abortSignal: signal } = ctx
  const io = ctx.workspaceIO ?? localWorkspaceIO
  const { relative, dirname, join, isAbsolute } = io.path
  let directories = 0
  let files = 0
  async function entriesAt(directory: string) {
    signal.throwIfAborted()
    return io.fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      if (error.code === 'EACCES' || error.code === 'EPERM') { status.unreadable++; return [] }
      throw error
    })
  }
  let inherited: IgnoreFile[] = []
  if (gitignore) {
    const relativeRoot = relative(projectDir, root)
    if (!isAbsolute(relativeRoot) && relativeRoot !== '..' && !relativeRoot.startsWith('..' + io.path.sep)) {
      const ancestors: string[] = []
      for (let dir = root; relative(projectDir, dir); dir = dirname(dir)) ancestors.push(dirname(dir))
      for (const dir of ancestors.reverse()) inherited = await directoryRules(io, dir, inherited, await entriesAt(dir), signal)
      // rg 从显式指定的目录开始遍历。ignore.test 会重查祖先，因此放行到起点为止的目录层级。
      // 实际枚举的条目都比起点更深，仍由原来的规则决定。
      for (const { directory, rules } of inherited) {
        const path = relative(directory, root).replaceAll('\\', '/')
        if (rules.ignores(path + '/')) {
          const depth = path.split('/').length
          rules.add(Array.from({ length: depth }, (_, index) => '!' + '/*'.repeat(index + 1) + '/'))
        }
      }
    }
  }
  async function* visit(directory: string, parentRules: IgnoreFile[]): AsyncGenerator<string> {
    if (++directories > 20_000) { status.limited = true; return }
    const entries = await entriesAt(directory)
    const rules = gitignore ? await directoryRules(io, directory, parentRules, entries, signal) : parentRules
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const entry of entries) {
      signal.throwIfAborted()
      const isDirectory = entry.isDirectory()
      if (IGNORED_DIRS.has(entry.name) || (!isDirectory && !entry.isFile())) continue
      const path = join(directory, entry.name)
      let ignored = false
      for (const scope of rules) {
        const key = relative(scope.directory, path).replaceAll('\\', '/') + (isDirectory ? '/' : '')
        const result = scope.rules.test(key)
        if (result.ignored || result.unignored) { ignored = result.ignored; break }
      }
      if (ignored) continue
      if (isDirectory) {
        yield* visit(path, rules)
        if (status.limited) return
      } else {
        if (++files > 200_000) { status.limited = true; return }
        yield path
      }
    }
  }
  yield* visit(root, inherited)
}
