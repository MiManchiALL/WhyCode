import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, existsSync, readdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { simpleGit, type SimpleGit } from 'simple-git'

/**
 * Shadow git 检查点（M2-c，文档一 §3.3）。设计取舍见调研：
 * - 隔离用 GIT_DIR/GIT_WORK_TREE/GIT_CONFIG_* 环境变量（Gemini CLI 方案），免疫用户全局 git 配置
 * - 用户项目里零文件；排除表写 shadow 仓库的 .git/info/exclude
 * - 快照在写类工具执行前（恢复语义直达「执行前」）；工作区干净则复用 HEAD
 * - 核心不变量：任何失败只禁用、不抛错到 Agent 循环
 */

const INIT_TIMEOUT_MS = 20_000

/** 排除表（Cline pattern 表精简版 + Windows 项 + .env 默认排除——用户决策 2026-07-04） */
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

/** 在这些目录直接启用检查点等于把整个用户空间 add 进 git，拒绝 */
function isForbiddenRoot(projectDir: string): boolean {
  const home = resolve(homedir())
  const norm = resolve(projectDir)
  const forbidden = [home, ...['Desktop', 'Documents', 'Downloads'].map((d) => join(home, d))]
  return forbidden.some((f) => f.toLowerCase() === norm.toLowerCase())
}

export class CheckpointManager {
  private git: SimpleGit | null = null
  private disabledReason: string | null = null
  private initPromise: Promise<void> | null = null
  private readonly projectDir: string
  private readonly repoDir: string

  constructor(projectDir: string, storageRoot: string) {
    this.projectDir = resolve(projectDir)
    const hash = createHash('sha256')
      .update(this.projectDir.toLowerCase())
      .digest('hex')
      .slice(0, 16)
    this.repoDir = join(storageRoot, hash)
  }

  get disabled(): string | null {
    return this.disabledReason
  }

  /** 懒初始化（幂等，防并发重入）；失败/超时 → 永久禁用本会话检查点 */
  private ensureInit(): Promise<void> {
    this.initPromise ??= Promise.race([
      this.doInit(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`初始化超时（${INIT_TIMEOUT_MS}ms），项目可能过大`)), INIT_TIMEOUT_MS),
      ),
    ]).catch((error: unknown) => {
      this.disabledReason = error instanceof Error ? error.message : String(error)
      this.git = null
    })
    return this.initPromise
  }

  private async doInit(): Promise<void> {
    if (isForbiddenRoot(this.projectDir)) {
      throw new Error('项目目录是主目录/桌面/文档等系统目录，已禁用检查点')
    }
    mkdirSync(this.repoDir, { recursive: true })
    const gitDir = join(this.repoDir, '.git')
    // 专用配置：免疫用户全局 gitconfig（autocrlf/签名/代理等）
    const configPath = join(this.repoDir, 'gitconfig')
    const emptyConfig = join(this.repoDir, 'gitconfig.empty')
    writeFileSync(
      configPath,
      [
        '[user]', '\tname = WhyCode Checkpoint', '\temail = checkpoint@whycode.local',
        '[commit]', '\tgpgsign = false',
        '[core]', '\tautocrlf = false', '\tlongpaths = true',
        '[gc]', '\tauto = 0',
      ].join('\n') + '\n',
    )
    if (!existsSync(emptyConfig)) writeFileSync(emptyConfig, '')

    const git = simpleGit({
      baseDir: this.projectDir,
      // GIT_CONFIG_* 路径完全由本类生成（storage 目录内），非用户输入；
      // 该开关只放开「用环境变量指定配置路径」这一类，其余安全检查保持默认
      unsafe: { allowUnsafeConfigPaths: true },
    }).env({
      GIT_DIR: gitDir,
      GIT_WORK_TREE: this.projectDir,
      GIT_CONFIG_GLOBAL: configPath,
      GIT_CONFIG_SYSTEM: emptyConfig,
    })
    await git.version() // git 不存在时在此抛错 → 禁用

    // 启动清理：上次进程崩溃可能遗留 .git_disabled
    this.renameNestedGitRepos(false)

    if (!existsSync(gitDir)) {
      await git.init()
      writeFileSync(join(gitDir, 'info', 'exclude'), EXCLUDE_PATTERNS.join('\n') + '\n')
      await this.commitAll(git, 'baseline')
    } else {
      // 已有仓库：校验归属，防路径哈希碰撞/项目被移动
      const worktree = await git.raw(['config', '--local', 'core.whycodeProject']).catch(() => '')
      if (worktree.trim() && worktree.trim() !== this.projectDir.toLowerCase()) {
        throw new Error('检查点仓库与当前项目不匹配')
      }
      writeFileSync(join(gitDir, 'info', 'exclude'), EXCLUDE_PATTERNS.join('\n') + '\n')
    }
    await git.raw(['config', '--local', 'core.whycodeProject', this.projectDir.toLowerCase()])
    this.git = git
  }

  /** 拍快照：返回 commit hash；干净则复用 HEAD；失败返回 null（绝不抛） */
  async save(): Promise<string | null> {
    try {
      await this.ensureInit()
      if (!this.git) return null
      const status = await this.git.status()
      if (status.files.length === 0) {
        return (await this.git.revparse(['HEAD'])).trim()
      }
      return await this.commitAll(this.git, 'checkpoint')
    } catch {
      return null // 不变量：检查点失败不中断 Agent
    }
  }

  /** 恢复文件到某快照：restore --source（不动 HEAD，可再前进）+ clean 清掉快照后新建的文件 */
  async restoreFiles(hash: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.ensureInit()
      if (!this.git) return { ok: false, error: this.disabledReason ?? '检查点不可用' }
      this.renameNestedGitRepos(true)
      try {
        // --staged 必须带：只恢复 worktree 的话，复活的已删除文件在 index 中缺失，
        // 会被随后的 clean -fd 当 untracked 再删掉
        await this.git.raw(['restore', '--source', hash, '--staged', '--worktree', '--', '.'])
        await this.git.raw(['clean', '-fd'])
      } finally {
        this.renameNestedGitRepos(false)
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async commitAll(git: SimpleGit, message: string): Promise<string> {
    this.renameNestedGitRepos(true)
    try {
      await git.raw(['add', '-A', '--ignore-errors']).catch(() => git.raw(['add', '-A']))
      const result = await git.raw(['commit', '-m', message, '--allow-empty', '--no-verify'])
      void result
      return (await git.revparse(['HEAD'])).trim()
    } finally {
      this.renameNestedGitRepos(false)
    }
  }

  /**
   * 嵌套 git 仓库改名防御（根级 .git 由 GIT_DIR 隔离天然无关）：
   * add 前 .git → .git_disabled，避免被当 submodule；finally 还原。
   */
  private renameNestedGitRepos(disable: boolean): void {
    const [from, to] = disable ? ['.git', '.git_disabled'] : ['.git_disabled', '.git']
    const scan = (dir: string, depth: number): void => {
      if (depth > 6) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name === 'node_modules') continue
        const full = join(dir, e.name)
        if (e.name === from && dir !== this.projectDir) {
          try {
            renameSync(full, join(dir, to))
          } catch {
            /* Windows 文件锁：跳过该仓库，不阻塞整体 */
          }
        } else if (!e.name.startsWith('.git')) {
          scan(full, depth + 1)
        }
      }
    }
    scan(this.projectDir, 0)
  }
}
