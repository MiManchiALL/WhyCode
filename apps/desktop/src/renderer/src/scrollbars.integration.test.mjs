import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
test('滚动条区分正文与面板：双轴活动、淡出、悬浮、原生拖动和终端', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY,
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'whycode-scrollbars-'))
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()))
    assert.ok(path.basename(directory).startsWith('whycode-scrollbars-'))
    await rm(directory, { recursive: true, force: true })
  })
  await build({ configFile: false, root: desktop, logLevel: 'silent', plugins: [react(), tailwindcss()],
    define: { 'process.env.NODE_ENV': '"production"' },
    build: { outDir: directory, emptyOutDir: false, minify: false, lib: {
      entry: path.join(desktop, 'src/renderer/src/test-fixtures/scrollbars.tsx'), name: 'ScrollbarFixture',
      formats: ['iife'], fileName: () => 'renderer.js', cssFileName: 'renderer',
    } },
  })
  await writeFile(path.join(directory, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="./renderer.css"><div id="root"></div><script src="./renderer.js"></script>')
  const env = { ...process.env, WHYCODE_SCROLLBAR_TEST_DIR: directory }
  delete env.ELECTRON_RUN_AS_NODE
  const { stdout, stderr } = await promisify(execFile)(require('electron'), [
    path.join(desktop, 'src/main/test-fixtures/scrollbars.mjs'),
  ], { env, windowsHide: true, timeout: 45_000 })
  assert.match(stdout, /scrollbars passed/)
  assert.doesNotMatch(stderr, /Uncaught|UnhandledPromiseRejection/)
})
