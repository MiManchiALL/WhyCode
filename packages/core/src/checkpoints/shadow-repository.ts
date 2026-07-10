import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { lstat, readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { simpleGit, type SimpleGit } from 'simple-git'

const INIT_TIMEOUT_MS = 20_000

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

  async capture(sessionId: string, checkpointId: string, phase: string): Promise<string> {
    await this.ensureInit()
    const git = this.requiredGit()
    await git.raw(['read-tree', '--empty'])
    await git.raw(['add', '-A', '--ignore-errors']).catch(() => git.raw(['add', '-A']))
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
    const git = simpleGit({
      baseDir: this.root,
      unsafe: { allowUnsafeConfigPaths: true },
    }).env({
      GIT_DIR: this.gitDir,
      GIT_WORK_TREE: this.root,
      GIT_CONFIG_GLOBAL: configPath,
      GIT_CONFIG_SYSTEM: emptyConfig,
    })
    await git.version()
    if (!existsSync(this.gitDir)) await git.init()
    const owner = await git.raw(['config', '--local', 'core.whycodeRoot']).catch(() => '')
    if (owner.trim() && pathKey(owner.trim()) !== pathKey(this.root)) {
      throw new Error(`树快照仓库归属不匹配：${this.root}`)
    }
    writeFileSync(join(this.gitDir, 'info', 'exclude'), `${EXCLUDE_PATTERNS.join('\n')}\n`)
    await git.raw(['config', '--local', 'core.whycodeRoot', this.root])
    this.git = git
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
}

/** 删除会话时释放共享仓库中的引用；对象随后才有资格被 Git GC。 */
export async function releaseShadowRefs(storageRoot: string, sessionId: string): Promise<void> {
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
    const git = simpleGit({ baseDir: storageDir }).env({ GIT_DIR: gitDir })
    const prefix = `refs/whycode/${sessionId}/`
    const refs = (await git.raw(['for-each-ref', '--format=%(refname)', prefix]))
      .split(/\r?\n/)
      .filter(Boolean)
    for (const ref of refs) await git.raw(['update-ref', '-d', ref])
    if (refs.length > 0) await git.raw(['gc', '--prune=now']).catch(() => {})
  }
}
