import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { runDependencyProcess } from './process.ts'

export const NODE_VERSION = '24.21.0'
const hashes: Record<string, string> = {
  'win-x64.zip': '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541',
  'win-arm64.zip': '8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921',
  'linux-x64.tar.xz': 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6',
  'linux-arm64.tar.xz': '6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2',
  'darwin-x64.tar.gz': '1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097',
  'darwin-arm64.tar.gz': 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057',
}

export async function nodeArchive(cache: string, platform: string, arch: string, signal: AbortSignal, progress: (message: string) => void): Promise<string> {
  const suffix = `${platform === 'win32' ? 'win' : platform}-${arch}.${platform === 'win32' ? 'zip' : platform === 'linux' ? 'tar.xz' : 'tar.gz'}`
  const expected = hashes[suffix]
  if (!expected) throw new Error(`工作区运行环境暂不支持 ${platform}/${arch}`)
  const name = `node-v${NODE_VERSION}-${suffix}`
  const file = join(cache, name)
  await mkdir(cache, { recursive: true })
  try { if (createHash('sha256').update(await readFile(file)).digest('hex') === expected) return file }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const temporary = `${file}.${randomUUID()}.tmp`
  progress(`正在下载 Node ${NODE_VERSION}（${platform}/${arch}）`)
  const response = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/${name}`, { signal })
  if (!response.ok || !response.body) throw new Error(`Node 下载失败：HTTP ${response.status}`)
  const handle = await open(temporary, 'wx', 0o600)
  const hash = createHash('sha256')
  let received = 0, reported = 0
  try {
    for await (const chunk of response.body) {
      signal.throwIfAborted()
      received += chunk.byteLength
      if (received > 120 * 1024 * 1024) throw new Error('Node 下载超过大小上限')
      hash.update(chunk); await handle.writeFile(chunk)
      if (received - reported > 8 * 1024 * 1024) { progress(`Node 已下载 ${Math.round(received / 1024 / 1024)} MiB`); reported = received }
    }
    if (hash.digest('hex') !== expected) throw new Error('Node 下载校验失败')
    await handle.close()
    await rename(temporary, file)
    return file
  } finally { await handle.close(); await rm(temporary, { force: true }) }
}

export async function localNode(cache: string, signal: AbortSignal, progress: (message: string) => void): Promise<{ executable: string; npm: string }> {
  const root = join(cache, `node-${NODE_VERSION}-${process.platform}-${process.arch}`)
  const executable = join(root, process.platform === 'win32' ? 'node.exe' : 'bin/node')
  const npm = join(root, process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : 'lib/node_modules/npm/bin/npm-cli.js')
  try { if ((await runDependencyProcess(executable, ['--version'], root, signal)).trim() === `v${NODE_VERSION}`) return { executable, npm } }
  catch (error) { signal.throwIfAborted(); if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const archive = await nodeArchive(cache, process.platform, process.arch, signal, progress)
  const staging = `${root}.${randomUUID()}.tmp`
  await mkdir(staging)
  try {
    await runDependencyProcess('tar', ['-xf', archive, '-C', staging, '--strip-components=1'], dirname(staging), signal)
    await rename(staging, root)
  } finally { await rm(staging, { recursive: true, force: true }) }
  return { executable, npm }
}
