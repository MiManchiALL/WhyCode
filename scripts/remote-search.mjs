import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

// Official release archives are pinned; the server never downloads or installs packages.
const VERSION = '15.1.0'
const RELEASES = [
  ['x64', 'x86_64-unknown-linux-musl', '1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599'],
  ['arm64', 'aarch64-unknown-linux-gnu', '2b661c6ef508e902f388e9098d9c4c5aca72c87b55922d94abdba830b4dc885e'],
]
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

export async function prepareRemoteSearch(root, output) {
  const cache = join(root, '.cache', 'remote-search')
  await mkdir(cache, { recursive: true })
  await mkdir(output, { recursive: true })
  for (const [arch, target, expected] of RELEASES) {
    const name = `ripgrep-${VERSION}-${target}`
    const archive = join(cache, `${name}.tar.gz`)
    let bytes = await readFile(archive).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (!bytes) {
      const response = await fetch(`https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}/${name}.tar.gz`, {
        signal: AbortSignal.timeout(60_000),
      })
      if (!response.ok) throw new Error(`下载远端搜索组件失败：HTTP ${response.status}`)
      bytes = Buffer.from(await response.arrayBuffer())
      if (digest(bytes) !== expected) throw new Error(`远端搜索组件校验失败：${name}`)
      await writeFile(archive, bytes)
    }
    if (digest(bytes) !== expected) throw new Error(`远端搜索组件缓存校验失败：${archive}`)
    for (const [member, destination] of [['rg', `ripgrep-linux-${arch}`], ['LICENSE-MIT', 'ripgrep-LICENSE-MIT'], ['UNLICENSE', 'ripgrep-UNLICENSE']]) {
      const result = spawnSync('tar', ['-xOf', archive, `${name}/${member}`], { windowsHide: true, maxBuffer: 20 * 1024 * 1024 })
      if (result.error || result.status !== 0) throw new Error(`解包远端搜索组件失败：${result.error?.message ?? result.stderr.toString()}`)
      const path = join(output, destination)
      const existing = await readFile(path).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (!existing?.equals(result.stdout)) await writeFile(path, result.stdout)
    }
  }
}
