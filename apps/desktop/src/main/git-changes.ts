import { CHECKPOINT_FILE_PREVIEW_MAX_BYTES as GIT_PREVIEW_BYTES, readFileTextPreview, decodeTextPreview, outsideWorkspaceBoundary, type CheckpointFilePreviewState } from '@whycode/core'
import { GIT_MAX_FILES, type GitChanges, type GitComparison, type GitFileChange, type GitFilePreview, type GitRepositoryInfo } from '../shared/git.ts'
import { requireGitSuccess } from './git-process.ts'
import { GitRepository } from './git-repository.ts'

interface GitEntry extends GitFileChange { before: string; after: string; beforeMode: string; afterMode: string }
interface ComparisonRange { args: string[]; working: boolean; untracked: boolean; label: string }

async function comparisonRange(repo: GitRepository, info: GitRepositoryInfo, query: GitComparison): Promise<ComparisonRange> {
  if (query.mode === 'unstaged') return { args: [], working: true, untracked: true, label: '暂存区 → 工作区' }
  if (query.mode === 'staged') return { args: ['--cached'], working: false, untracked: false, label: 'HEAD → 暂存区' }
  if (query.mode === 'commit') {
    const commit = await repo.commit(query.commit)
    const parents = (await repo.text(['rev-list', '--parents', '-n', '1', commit], '读取提交父节点')).trim().split(' ')
    const before = parents[1] ?? await emptyTree(repo)
    return { args: [before, commit], working: false, untracked: false, label: `${before.slice(0, 7)} → ${commit.slice(0, 7)}` }
  }
  const base = query.mode === 'branch' ? query.baseRef ?? info.defaultBase : null
  const before = base ? await repo.commit(base) : info.head ?? await emptyTree(repo)
  return { args: [before], working: true, untracked: true,
    label: base?.replace(/^refs\/(heads|remotes)\//u, '') ?? (info.head ? info.branch ?? 'HEAD' : '空仓库') }
}

async function emptyTree(repo: GitRepository): Promise<string> {
  return (await repo.text(['hash-object', '-t', 'tree', '--stdin'], '读取空树')).trim()
}

export async function readGitChanges(repo: GitRepository, info: GitRepositoryInfo, query: GitComparison): Promise<GitChanges> {
  const range = await comparisonRange(repo, info, query)
  const { entries, truncated } = await readEntries(repo, range)
  return {
    files: entries.map(({ before: _before, after: _after, beforeMode: _beforeMode, afterMode: _afterMode, ...file }) => file),
    added: entries.reduce((total, file) => total + (file.added ?? 0), 0),
    removed: entries.reduce((total, file) => total + (file.removed ?? 0), 0),
    untracked: entries.filter(file => file.status === '?').length,
    truncated, baseLabel: range.label,
  }
}

async function readEntries(repo: GitRepository, range: ComparisonRange): Promise<{ entries: GitEntry[]; truncated: boolean }> {
  const result = await repo.run(['diff', '--raw', '--numstat', '-z', '--no-color', '--no-abbrev', '--find-renames', '-l200',
    '--no-ext-diff', '--no-textconv', ...range.args, '--'], { outputLimit: 4 * 1024 * 1024 })
  requireGitSuccess(result, '读取变更清单')
  const entries = parseDiffEntries(result.stdout, repo)
  let truncated = result.outputTruncated || entries.length > GIT_MAX_FILES
  if (range.untracked) {
    const untracked = await repo.run(['ls-files', '--others', '--exclude-standard', '-z', '--'], { outputLimit: 1024 * 1024 })
    requireGitSuccess(untracked, '读取未跟踪文件')
    truncated ||= untracked.outputTruncated
    const tracked = new Map(entries.map(file => [file.relativePath, file]))
    for (const relativePath of untracked.stdout.split('\0').slice(0, -1)) {
      const previous = tracked.get(relativePath)
      if (previous) {
        previous.status = '?'
        previous.added = undefined
        previous.removed = undefined
        previous.afterMode = '100644'
      } else {
        entries.push({ path: repo.io.path.resolve(repo.root, relativePath), relativePath, oldPath: null,
          status: '?', binary: false, before: '', after: '', beforeMode: '000000', afterMode: '100644' })
      }
      if (entries.length > GIT_MAX_FILES) { truncated = true; break }
    }
  }
  return { entries: entries.slice(0, GIT_MAX_FILES), truncated }
}

function parseDiffEntries(raw: string, repo: GitRepository): GitEntry[] {
  const records = raw.split('\0')
  const byPath = new Map<string, GitEntry>()
  for (let i = 0; i < records.length - 1; i++) {
    const record = records[i]!
    if (record.startsWith(':')) {
      const [beforeMode, afterMode, before, after, status] = record.slice(1).split(' ')
      const source = records[++i]
      const renamed = status?.startsWith('R') || status?.startsWith('C')
      const target = renamed ? records[++i] : source
      if (!target || !status || !before || !after || !beforeMode || !afterMode) continue
      const file: GitEntry = { path: repo.io.path.resolve(repo.root, target), relativePath: target,
        oldPath: renamed ? source! : null, status: status[0]!, binary: false, before, after, beforeMode, afterMode }
      if (byPath.get(target)?.status !== 'U') byPath.set(target, file)
    } else {
      const match = /^(\d+|-)\t(\d+|-)\t(.*)$/su.exec(record)
      if (!match) continue
      const target = match[3] || (i++, records[++i])
      const file = target ? byPath.get(target) : undefined
      if (!file || file.status === 'U') continue
      file.binary = match[1] === '-'
      if (!file.binary) { file.added = Number(match[1]); file.removed = Number(match[2]) }
    }
  }
  return [...byPath.values()]
}

export async function readGitFilePreview(repo: GitRepository, info: GitRepositoryInfo, query: GitComparison, relativePath: string): Promise<GitFilePreview> {
  const absolute = repo.io.path.resolve(repo.root, relativePath)
  const relative = repo.io.path.relative(repo.root, absolute)
  if (!relative || relative === '..' || relative.startsWith(`..${repo.io.path.sep}`) || repo.io.path.isAbsolute(relative)) {
    throw new Error('文件必须位于当前 Git 仓库内')
  }
  const range = await comparisonRange(repo, info, query)
  const { entries } = await readEntries(repo, range)
  const file = entries.find(entry => entry.relativePath === relativePath)
  if (!file) throw new Error('该文件的变更已消失，请刷新列表')
  if (file.status === 'U') throw new Error('文件处于冲突状态，请打开当前文件解决冲突')
  const [before, after] = await Promise.all([
    readBlob(repo, file.before, file.beforeMode),
    range.working && file.afterMode !== '000000' ? readWorkingFile(repo, absolute) : readBlob(repo, file.after, file.afterMode),
  ])
  return { path: absolute, before, after }
}

async function readBlob(repo: GitRepository, hash: string, mode: string): Promise<CheckpointFilePreviewState> {
  if (mode === '000000') return { kind: 'missing' }
  if (mode === '160000') return { kind: 'unavailable', reason: 'binary', size: 0 }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(hash) || /^0+$/u.test(hash)) throw new Error('文件处于冲突状态，请先解决冲突')
  const size = Number((await repo.text(['cat-file', '-s', hash], '读取文件大小')).trim())
  if (size > GIT_PREVIEW_BYTES) return { kind: 'unavailable', reason: 'too-large', size }
  const result = await repo.run(['cat-file', 'blob', hash], { encoding: 'base64', outputLimit: GIT_PREVIEW_BYTES + 1 })
  requireGitSuccess(result, '读取 Git 文件')
  if (result.outputTruncated) return { kind: 'unavailable', reason: 'too-large', size }
  return decodeTextPreview(Buffer.from(result.stdout, 'base64'))
}

async function readWorkingFile(repo: GitRepository, path: string): Promise<CheckpointFilePreviewState> {
  const stat = await repo.io.fs.lstat(path)
  if (!stat.isFile()) return { kind: 'unavailable', reason: 'binary', size: stat.size }
  if (await outsideWorkspaceBoundary(repo.io, path, repo.root, [])) throw new Error('文件链接超出仓库范围')
  const preview = await readFileTextPreview(path, repo.io)
  if (preview.kind !== 'text' || !preview.content.includes('\r\n')) return preview
  const eol = await repo.text(['ls-files', '--eol', '--cached', '--others', '--exclude-standard', '-z', '--',
    repo.io.path.relative(repo.root, path)], '读取换行符设置')
  const match = /^i\/(\S*)\s+w\/(\S*)\s+attr\/([^\t]*)\t/u.exec(eol)
  const attribute = match?.[3]?.trim()
  if (!match || attribute === '-text') return preview
  const explicitText = attribute === 'text' || attribute?.startsWith('text eol=')
  let automatic = attribute?.startsWith('text=auto')
  if (!attribute) {
    const config = await repo.run(['config', '--get', 'core.autocrlf'])
    if (config.code !== 1) requireGitSuccess(config, '读取换行符配置')
    automatic = ['true', 'input'].includes(config.stdout.trim())
  }
  // 自动转换保留已以 CRLF 入库的文件；显式 text 则始终规范化，遵循 Git 的入库语义。
  const normalize = explicitText || automatic && !['crlf', 'mixed'].includes(match[1]!) && match[2] !== '-text'
  return normalize ? { ...preview, content: preview.content.replaceAll('\r\n', '\n') } : preview
}
