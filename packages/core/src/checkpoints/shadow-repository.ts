import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { lstat, readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { simpleGit, type SimpleGit } from 'simple-git'
import { validateSessionId } from '../session/metadata.ts'

const INIT_TIMEOUT_MS = 20_000
const GIT_IDLE_TIMEOUT_MS = 20_000
const MAX_TREE_FILES = 20_000
const MAX_TREE_FILE_BYTES = 64 * 1024 * 1024
const MAX_TREE_TOTAL_BYTES = 256 * 1024 * 1024

/** 树快照有意排除高成本/敏感内容；调用方必须把对应检查点标为 partial。 */
const EXCLUDE_PATTERNS = [
  '.git/', '.git_disabled/', 'node_modules/', 'dist/', 'out/', 'build/', 'release/',
  'target/', '__pycache__/', 'venv/', '.venv/', 'vendor/', '.next/', '.nuxt/',
  '.gradle/', '.idea/', '.vscode/', '.vs/', 'coverage/', '.cache/', '.pnpm-store/',
  '.pnpm-cache/', '.whycode/',
  '*.env*', '*.local',
  '*.jpg', '*.jpeg', '*.png', '*.gif', '*.mp4', '*.mp3', '*.wav', '*.mov', '*.pdf',
  '*.zip', '*.tar', '*.gz', '*.7z', '*.iso', '*.exe', '*.dll', '*.so', '*.dylib',
  '*.sqlite', '*.db', '*.parquet',
  '*.tmp', '*.log', '*.swp', 'Thumbs.db', 'desktop.ini', '.DS_Store',
]

function pathKey(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isForbiddenRoot(root: string): boolean {
  const home = resolve(homedir())
  const forbidden = [home, ...['Desktop', 'Documents', 'Downloads'].map((name) => join(home, name))]
  if (forbidden.some((path) => pathKey(path) === pathKey(root))) return true
  const systemRoots = [
    process.env.SystemRoot,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramData,
  ].filter((path): path is string => Boolean(path)).map((path) => resolve(path))
  return systemRoots.some((systemRoot) => {
    const rel = relative(systemRoot, root)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }) || resolve(root) === resolve(root).slice(0, 3)
}

function repositoryKey(root: string): string {
  return createHash('sha256').update(pathKey(root)).digest('hex').slice(0, 24)
}

function refName(sessionId: string, checkpointId: string, phase: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(phase)) throw new Error(`无效快照阶段：${phase}`)
  return `refs/whycode/${sessionId}/${checkpointId}/${phase}`
}

export class ShadowRepository {
  readonly root: string
  private readonly storageDir: string
  private readonly gitDir: string
  private git: SimpleGit | null = null
  private initPromise: Promise<void> | null = null

  constructor(root: string, storageRoot: string) {
    this.root = resolve(root)
    this.storageDir = join(resolve(storageRoot), 'roots', repositoryKey(this.root))
    this.gitDir = join(this.storageDir, '.git')
  }

  async capture(
    sessionId: string,
    checkpointId: string,
    phase: string,
    paths?: string[],
  ): Promise<string> {
    await this.ensureInit()
    const git = await this.sessionGit(sessionId)
    const scopedPaths = paths
      ? [...new Set(paths.map((path) => this.relativePath(path)))]
      : undefined
    if (!scopedPaths) await this.assertTreeBudget(git)
    if (scopedPaths) {
      const { existing, missing } = await this.partitionPaths(scopedPaths)
      for (let offset = 0; offset < missing.length; offset += 128) {
        await git.raw([
          'update-index', '--force-remove', '--', ...missing.slice(offset, offset + 128),
        ])
      }
      for (let offset = 0; offset < existing.length; offset += 128) {
        await this.stage(git, existing.slice(offset, offset + 128))
      }
    } else {
      await this.stage(git)
    }
    const tree = (await git.raw(['write-tree'])).trim()
    const commit = (await git.raw(['commit-tree', tree, '-m', `WhyCode ${phase}`])).trim()
    await git.raw(['update-ref', refName(sessionId, checkpointId, phase), commit])
    return commit
  }

  async changedPaths(beforeHash: string, afterHash: string): Promise<string[]> {
    await this.ensureInit()
    const output = await this.requiredGit().raw([
      'diff', '--name-only', '-z', beforeHash, afterHash,
    ])
    return output.split('\0').filter(Boolean)
  }

  async matchesSnapshot(expectedHash: string, actualHash: string, paths: string[]): Promise<boolean> {
    if (paths.length === 0) return true
    await this.ensureInit()
    const output = await this.requiredGit().raw([
      'diff', '--name-only', '-z', expectedHash, actualHash, '--', ...paths,
    ])
    return output.length === 0
  }

  async restorePaths(hash: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return
    await this.ensureInit()
    const git = this.requiredGit()
    for (const path of paths) {
      const absolute = this.absolutePath(path)
      const exists = await git.raw(['cat-file', '-e', `${hash}:${path}`]).then(
        () => true,
        () => false,
      )
      if (exists) {
        await git.raw(['restore', '--source', hash, '--worktree', '--', path])
      } else {
        await rm(absolute, { recursive: true, force: true })
      }
    }
  }

  async deleteCheckpointRefs(sessionId: string, checkpointId: string): Promise<void> {
    await this.ensureInit()
    const git = this.requiredGit()
    const prefix = `refs/whycode/${sessionId}/${checkpointId}/`
    const refs = (await git.raw(['for-each-ref', '--format=%(refname)', prefix]))
      .split(/\r?\n/)
      .filter(Boolean)
    await Promise.all(refs.map((ref) => git.raw(['update-ref', '-d', ref])))
  }

  private ensureInit(): Promise<void> {
    // 共享仓库可能在最后一个会话 ref 被释放后整库回收；其它会话持有的实例
    // 必须在下一次使用时自愈，不能永久保留一个已失效的 GIT_DIR。
    if (this.git && !existsSync(this.gitDir)) {
      this.git = null
      this.initPromise = null
    }
    this.initPromise ??= new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`树快照初始化超时（${INIT_TIMEOUT_MS}ms）：${this.root}`)),
        INIT_TIMEOUT_MS,
      )
      void this.initialize().then(
        () => {
          clearTimeout(timer)
          resolvePromise()
        },
        (error) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
    return this.initPromise
  }

  private async initialize(): Promise<void> {
    if (isForbiddenRoot(this.root)) throw new Error(`目录范围过大，已拒绝树快照：${this.root}`)
    const stats = await lstat(this.root)
    if (!stats.isDirectory()) throw new Error(`树快照根不是目录：${this.root}`)
    mkdirSync(this.storageDir, { recursive: true })
    const configPath = join(this.storageDir, 'gitconfig')
    const emptyConfig = join(this.storageDir, 'gitconfig.empty')
    writeFileSync(configPath, [
      '[user]', '\tname = WhyCode Checkpoint', '\temail = checkpoint@whycode.local',
      '[commit]', '\tgpgsign = false',
      '[core]', '\tautocrlf = false', '\tlongpaths = true', '\tquotePath = false',
      '[gc]', '\tauto = 0',
    ].join('\n') + '\n')
    if (!existsSync(emptyConfig)) writeFileSync(emptyConfig, '')
    const git = this.createGit()
    await git.version()
    if (!existsSync(this.gitDir)) await git.init()
    await Promise.all([
      rm(join(this.gitDir, 'index'), { force: true }),
      rm(join(this.gitDir, 'index.lock'), { force: true }),
    ])
    const owner = await git.raw(['config', '--local', 'core.whycodeRoot']).catch(() => '')
    if (owner.trim() && pathKey(owner.trim()) !== pathKey(this.root)) {
      throw new Error(`树快照仓库归属不匹配：${this.root}`)
    }
    writeFileSync(join(this.gitDir, 'info', 'exclude'), `${EXCLUDE_PATTERNS.join('\n')}\n`)
    await git.raw(['config', '--local', 'core.whycodeRoot', this.root])
    this.git = git
  }

  private createGit(indexPath?: string): SimpleGit {
    const git = simpleGit({
      baseDir: this.root,
      unsafe: { allowUnsafeConfigPaths: true },
      timeout: { block: GIT_IDLE_TIMEOUT_MS },
    }).env({
      GIT_DIR: this.gitDir,
      GIT_WORK_TREE: this.root,
      GIT_CONFIG_GLOBAL: join(this.storageDir, 'gitconfig'),
      GIT_CONFIG_SYSTEM: join(this.storageDir, 'gitconfig.empty'),
      ...(indexPath ? { GIT_INDEX_FILE: indexPath } : {}),
    })
    return git
  }

  private sessionIndexPath(sessionId: string): string {
    validateSessionId(sessionId)
    const indexDir = join(this.storageDir, 'indexes')
    mkdirSync(indexDir, { recursive: true })
    return join(indexDir, sessionId)
  }

  private async sessionGit(sessionId: string): Promise<SimpleGit> {
    const indexPath = this.sessionIndexPath(sessionId)
    await rm(`${indexPath}.lock`, { force: true })
    let git = this.createGit(indexPath)
    try {
      await git.raw(['ls-files', '--stage', '-z'])
    } catch {
      await rm(indexPath, { force: true })
      git = this.createGit(indexPath)
    }
    return git
  }

  private async assertTreeBudget(git: SimpleGit): Promise<void> {
    const output = await git.raw([
      'ls-files', '--cached', '--others', '--exclude-standard', '-z',
    ])
    const paths = [...new Set(output.split('\0').filter(Boolean))]
    if (paths.length > MAX_TREE_FILES) {
      throw new Error(`树快照超出文件数量预算（${MAX_TREE_FILES}）`)
    }
    let total = 0
    for (let offset = 0; offset < paths.length; offset += 64) {
      const batch = paths.slice(offset, offset + 64)
      const stats = await Promise.all(batch.map(async (path) => ({
        path,
        stats: await lstat(this.absolutePath(path)).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null
          throw error
        }),
      })))
      for (const entry of stats) {
        if (!entry.stats?.isFile()) continue
        if (entry.stats.size > MAX_TREE_FILE_BYTES) {
          throw new Error(
            `树快照超出单文件预算（64 MiB）：${entry.path}`,
          )
        }
        total += entry.stats.size
        if (total > MAX_TREE_TOTAL_BYTES) {
          throw new Error('树快照超出总容量预算（256 MiB）')
        }
      }
    }
  }

  private async partitionPaths(paths: string[]): Promise<{
    existing: string[]
    missing: string[]
  }> {
    const existing: string[] = []
    const missing: string[] = []
    for (let offset = 0; offset < paths.length; offset += 128) {
      const entries = await Promise.all(paths.slice(offset, offset + 128).map(async (path) => ({
        path,
        exists: await lstat(this.absolutePath(path)).then(
          (stats) => {
            if (!stats.isFile() && !stats.isSymbolicLink()) {
              throw new Error(`回滚路径类型已改变，已拒绝递归捕获：${path}`)
            }
            return true
          },
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return false
            throw error
          },
        ),
      })))
      for (const entry of entries) {
        if (entry.exists) existing.push(entry.path)
        else missing.push(entry.path)
      }
    }
    return { existing, missing }
  }

  private async stage(git: SimpleGit, paths?: string[]): Promise<void> {
    const force = paths ? ['-f'] : []
    const suffix = paths ? ['--', ...paths] : []
    await git.raw(['add', '-A', ...force, '--ignore-errors', ...suffix]).catch((error) => {
      if (String(error).includes('timeout')) throw this.captureTimeoutError()
      return git.raw(['add', '-A', ...force, ...suffix])
    })
  }

  private captureTimeoutError(): Error {
    return new Error(`树快照超过 ${GIT_IDLE_TIMEOUT_MS / 1000} 秒无进展，已停止捕获`)
  }

  private requiredGit(): SimpleGit {
    if (!this.git) throw new Error(`树快照仓库不可用：${this.root}`)
    return this.git
  }

  private absolutePath(path: string): string {
    if (isAbsolute(path)) throw new Error(`快照包含非法绝对路径：${path}`)
    const absolute = resolve(this.root, path)
    const rel = relative(this.root, absolute)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`快照路径越界：${path}`)
    return absolute
  }

  private relativePath(path: string): string {
    if (isAbsolute(path)) throw new Error(`快照包含非法绝对路径：${path}`)
    const absolute = this.absolutePath(path)
    return relative(this.root, absolute).replaceAll('\\', '/')
  }
}

/** 删除会话的共享引用，并立即回收不再被其他引用持有的对象。 */
export async function releaseShadowRefs(storageRoot: string, sessionId: string): Promise<void> {
  validateSessionId(sessionId)
  const rootsDir = join(resolve(storageRoot), 'roots')
  const entries = await readdir(rootsDir, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    },
  )
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const storageDir = join(rootsDir, entry.name)
    const gitDir = join(storageDir, '.git')
    if (!existsSync(gitDir)) continue
    const git = simpleGit({
      baseDir: storageDir,
      unsafe: { allowUnsafeConfigPaths: true },
    }).env({
      GIT_DIR: gitDir,
      GIT_CONFIG_GLOBAL: join(storageDir, 'gitconfig'),
      GIT_CONFIG_SYSTEM: join(storageDir, 'gitconfig.empty'),
    })
    const prefix = `refs/whycode/${sessionId}/`
    const refs = (await git.raw(['for-each-ref', '--format=%(refname)', prefix]))
      .split(/\r?\n/)
      .filter(Boolean)
    const targetIndex = join(storageDir, 'indexes', sessionId)
    if (
      refs.length === 0
      && !existsSync(targetIndex)
      && !existsSync(`${targetIndex}.lock`)
    ) {
      const hasLiveRefs = (await git.raw(['for-each-ref', '--format=%(refname)'])).trim() !== ''
      if (hasLiveRefs) continue
    }
    for (const ref of refs) await git.raw(['update-ref', '-d', ref])

    // 自定义 index 不属于 Git GC 的可达根；严格 GC 前全部丢弃，存活会话下次按 refs
    // 与工作区重建自己的缓存。它们从来不是检查点事实源。
    await Promise.all([
      rm(join(storageDir, 'indexes'), { recursive: true, force: true }),
      // 清理由旧版共享 index 遗留的可达性，避免删 ref 后内容仍被保留。
      rm(join(gitDir, 'index'), { force: true }),
      rm(join(gitDir, 'index.lock'), { force: true }),
    ])
    await git.raw(['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all'])

    const remainingRefs = (await git.raw(['for-each-ref', '--format=%(refname)']))
      .split(/\r?\n/)
      .filter(Boolean)
    if (remainingRefs.length === 0) {
      await rm(storageDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      })
      continue
    }
    await git.raw(['gc', '--prune=now'])
  }
}
