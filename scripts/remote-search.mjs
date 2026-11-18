import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const VERSION = '15.1.0'
const RELEASES = [
  ['ripgrep-linux-x64', 'x86_64-unknown-linux-musl', '1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599'],
  ['ripgrep-linux-arm64', 'aarch64-unknown-linux-gnu', '2b661c6ef508e902f388e9098d9c4c5aca72c87b55922d94abdba830b4dc885e'],
  ['ripgrep-win32-x64.exe', 'x86_64-pc-windows-msvc', '124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a'],
  ['ripgrep-win32-arm64.exe', 'aarch64-pc-windows-msvc', '00d931fb5237c9696ca49308818edb76d8eb6fc132761cb2a1bd616b2df02f8e'],
]
const readExisting = path => readFile(path).catch(error => { if (error.code === 'ENOENT') return null; throw error })

export async function prepareRemoteSearch(root, output) {
  const cache = join(root, '.cache', 'remote-search')
  await mkdir(cache, { recursive: true })
  await mkdir(output, { recursive: true })
  for (const [binary, target, expected] of RELEASES) {
    const windows = binary.endsWith('.exe')
    if (windows && process.platform !== 'win32') continue
    const name = `ripgrep-${VERSION}-${target}`
    const filename = name + (windows ? '.zip' : '.tar.gz')
    const archive = join(cache, filename)
    const cached = await readExisting(archive)
    let bytes = cached
    if (!bytes) {
      const response = await fetch(`https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}/${filename}`, {
        signal: AbortSignal.timeout(60_000),
      })
      if (!response.ok) throw new Error(`下载搜索组件失败：HTTP ${response.status}`)
      bytes = Buffer.from(await response.arrayBuffer())
    }
    if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(`搜索组件校验失败：${filename}`)
    if (!cached) await writeFile(archive, bytes)
    const members = [[windows ? 'rg.exe' : 'rg', binary]]
    if (binary === 'ripgrep-linux-x64') members.push(['LICENSE-MIT', 'ripgrep-LICENSE-MIT'], ['UNLICENSE', 'ripgrep-UNLICENSE'])
    for (const [member, destination] of members) {
      const result = spawnSync('tar', ['-xOf', archive, `${name}/${member}`], { windowsHide: true, maxBuffer: 20 * 1024 * 1024 })
      if (result.error || result.status !== 0) throw new Error(`解包搜索组件失败：${result.error?.message ?? result.stderr.toString()}`)
      const path = join(output, destination)
      if (!(await readExisting(path))?.equals(result.stdout)) await writeFile(path, result.stdout)
    }
  }
}
