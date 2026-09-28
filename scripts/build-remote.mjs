import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(root, 'remote')
const output = join(root, 'apps/desktop/resources/remote')
const hash = createHash('sha256')
for (const name of (await readdir(source)).filter(name => /\.(go|mod|sum)$/u.test(name)).sort()) {
  hash.update(name); hash.update(await readFile(join(source, name)))
}
const version = hash.digest('hex')
const manifest = join(output, 'source.sha256')
if (await readFile(manifest, 'utf8').catch(() => '') === version
  && ['x64', 'arm64'].every(arch => existsSync(join(output, `whycode-remote-linux-${arch}`)))) process.exit(0)
const portable = join(root, '.cache/toolchains/go/bin', process.platform === 'win32' ? 'go.exe' : 'go')
const go = process.env.WHYCODE_GO ?? (existsSync(portable) ? portable : 'go')
await mkdir(output, { recursive: true })
for (const [goarch, arch] of [['amd64', 'x64'], ['arm64', 'arm64']]) {
  const result = spawnSync(go, ['build', '-trimpath', '-ldflags=-s -w', '-o', join(output, `whycode-remote-linux-${arch}`), '.'], {
    cwd: source, windowsHide: true, stdio: 'inherit',
    env: { ...process.env, CGO_ENABLED: '0', GOOS: 'linux', GOARCH: goarch, GOPATH: join(root, '.cache/go'), GOCACHE: join(root, '.cache/go-build') },
  })
  if (result.error || result.status !== 0) throw new Error('远端组件构建失败：开发环境需要 Go 1.25+，也可通过 WHYCODE_GO 指定编译器')
}
await writeFile(manifest, version)
