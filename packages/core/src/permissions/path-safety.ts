import { basename, dirname, isAbsolute, parse, resolve, sep } from 'node:path'
import { realpathSync } from 'node:fs'

/**
 * 路径安全（M2-b）：敏感路径识别（由权限引擎按档位处理）+ Windows 可疑模式拒绝。
 * 清单参考 Claude Code 的 safetyCheck 与 hasSuspiciousWindowsPathPattern。
 */

/** 命中即强制审批的文件名（大小写不敏感） */
const SENSITIVE_FILES = new Set([
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.profile',
  '.npmrc',
])

/** 命中即强制审批的目录名（路径任一段，大小写不敏感） */
const SENSITIVE_DIRS = new Set(['.git', '.whycode', '.vscode', '.idea'])

/** Windows 设备名（任何扩展名下都保留设备语义） */
const DOS_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** 写类操作命中敏感路径；非全自动 Main 由权限引擎强制审批。 */
export function isSensitivePath(absPath: string): boolean {
  const name = basename(absPath).toLowerCase()
  if (SENSITIVE_FILES.has(name) || name.startsWith('.env')) return true
  return absPath
    .split(/[\\/]/)
    .some((segment) => SENSITIVE_DIRS.has(segment.toLowerCase()))
}

/**
 * Windows 可疑路径模式 → 直接拒绝（连审批都不给，防沙箱绕过）：
 * NTFS ADS 冒号流、8.3 短名、尾部点/空格、DOS 设备名、`\\?\` 前缀、UNC、`...` 段。
 */
export function findSuspiciousWindowsPattern(rawPath: string): string | null {
  if (rawPath.startsWith('\\\\?\\')) return '\\\\?\\ 长路径前缀'
  if (rawPath.startsWith('\\\\')) return 'UNC 网络路径'
  const withoutDrive = parse(rawPath).root ? rawPath.slice(parse(rawPath).root.length) : rawPath
  if (withoutDrive.includes(':')) return 'NTFS 数据流（冒号）'
  for (const segment of withoutDrive.split(/[\\/]/)) {
    if (!segment) continue
    // 纯导航段「.」「..」是合法相对路径写法，不属于 Win32 尾部点剥离攻击面
    if (segment === '.' || segment === '..') continue
    if (/~\d+$/.test(segment)) return '8.3 短文件名'
    if (/[. ]$/.test(segment)) return '尾部点或空格'
    if (segment === '...') return '连续点路径段'
    if (DOS_DEVICE_NAMES.test(segment)) return 'DOS 设备名'
  }
  return null
}

/** 归一化：绝对化 + Windows 小写盘符统一（供边界比较） */
export function normalizeForCompare(p: string): string {
  const abs = resolve(p)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

/** path 是否位于 dir 内（含 dir 本身）；纯词法比较，调用方需先归一化 */
function isInside(pathNorm: string, dirNorm: string): boolean {
  return pathNorm === dirNorm || pathNorm.startsWith(dirNorm + sep)
}

/**
 * 工作区边界检查：原路径 + realpath（若存在）双查，均须落在任一允许目录内。
 * 返回 null = 通过；否则返回越界的绝对路径（供生成 add-dir 建议）。
 */
export function findOutsideBoundary(
  inputPath: string,
  baseDir: string,
  allowedDirs: string[],
): string | null {
  const abs = isAbsolute(inputPath) ? resolve(inputPath) : resolve(baseDir, inputPath)
  const dirs = [baseDir, ...allowedDirs].map(normalizeForCompare)
  const candidates = [abs]
  try {
    // 文件不存在时对父目录做 realpath（新建文件场景），防 symlink 逃逸
    candidates.push(realpathSync(abs))
  } catch {
    try {
      candidates.push(resolve(realpathSync(dirname(abs)), basename(abs)))
    } catch {
      /* 父目录也不存在：仅词法检查 */
    }
  }
  for (const candidate of candidates) {
    const norm = normalizeForCompare(candidate)
    if (!dirs.some((d) => isInside(norm, d))) return abs
  }
  return null
}
