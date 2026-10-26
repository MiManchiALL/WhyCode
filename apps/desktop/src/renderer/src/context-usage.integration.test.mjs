import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const require = createRequire(import.meta.url)
const desktop = path.resolve(import.meta.dirname, '../../..')

test('上下文明细在旁边展开，切换分类不移动概览，并支持逐层关闭与窄窗口', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY,
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'whycode-context-ui-'))
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()))
    assert.ok(path.basename(directory).startsWith('whycode-context-ui-'))
    await rm(directory, { recursive: true, force: true })
  })
  await build({
    configFile: false, root: desktop, logLevel: 'silent', plugins: [react(), tailwindcss()],
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      outDir: directory, emptyOutDir: false, minify: false,
      lib: {
        entry: path.join(desktop, 'src/renderer/src/test-fixtures/context-usage.tsx'),
        name: 'ContextUsageFixture', formats: ['iife'], fileName: () => 'renderer.js', cssFileName: 'renderer',
      },
    },
  })
  const html = await readFile(path.join(desktop, 'src/renderer/index.html'), 'utf8')
  const fixture = html.replace('<script type="module" src="/src/main.tsx"></script>',
    '<link rel="stylesheet" href="./renderer.css"><script src="./renderer.js"></script>')
  assert.notEqual(fixture, html)
  await writeFile(path.join(directory, 'index.html'), fixture)
  const env = { ...process.env, WHYCODE_CONTEXT_TEST_DIR: directory }
  delete env.ELECTRON_RUN_AS_NODE
  const { stdout } = await promisify(execFile)(require('electron'), [path.join(desktop, 'src/main/test-fixtures/context-usage.mjs')], {
    env, windowsHide: true, timeout: 60_000,
  })
  assert.match(stdout, /context usage passed/)
})
