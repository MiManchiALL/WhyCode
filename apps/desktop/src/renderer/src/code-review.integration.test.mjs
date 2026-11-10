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
test('桌面代码跳转、原生拖选、引用预览和跨标签批注', {
  timeout: 120_000, skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY,
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'whycode-code-review-'))
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()))
    assert.ok(path.basename(directory).startsWith('whycode-code-review-'))
    await rm(directory, { recursive: true, force: true })
  })
  await build({
    root: desktop, base: './', configFile: false, logLevel: 'error', plugins: [react(), tailwindcss()],
    define: { 'process.env.NODE_ENV': '"production"' }, worker: { format: 'es' },
    build: {
      outDir: directory, emptyOutDir: false, minify: false,
      // 此用例加载源码及语法 Worker。PDF 和 Mermaid 属于其它预览模式的惰性入口。
      rollupOptions: { external: ['./pdf-preview.tsx', 'mermaid'] },
      lib: {
        entry: path.join(desktop, 'src/renderer/src/test-fixtures/code-review.tsx'),
        formats: ['es'], fileName: () => 'renderer.js', cssFileName: 'renderer',
      },
    },
  })
  await writeFile(path.join(directory, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="./renderer.css"><div id="root"></div><script type="module" src="./renderer.js"></script>')
  const env = { ...process.env, WHYCODE_REVIEW_TEST_DIR: directory }
  delete env.ELECTRON_RUN_AS_NODE
  const { stdout } = await promisify(execFile)(require('electron'), [path.join(desktop, 'src/main/test-fixtures/code-review.mjs')],
    { env, windowsHide: true, timeout: 90_000 })
  assert.match(stdout, /code review passed/)
})
