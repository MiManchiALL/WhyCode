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
test('真实 Electron：设置清理/导出、React/页面异常与独立网页/主界面崩溃报告', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY,
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'whycode-diagnostics-electron-'))
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()))
    assert.ok(path.basename(directory).startsWith('whycode-diagnostics-electron-'))
    await rm(directory, { recursive: true, force: true })
  })
  const common = { configFile: false, root: desktop, logLevel: 'silent' }
  await build({ ...common, plugins: [react(), tailwindcss()], define: { 'process.env.NODE_ENV': '"production"' },
    build: { outDir: directory, emptyOutDir: false, minify: false, lib: {
      entry: path.join(desktop, 'src/renderer/src/test-fixtures/diagnostics.tsx'),
      name: 'DiagnosticFixture', formats: ['iife'], fileName: () => 'renderer.js', cssFileName: 'renderer',
    } } })
  for (const [entry, output, format] of [
    ['src/main/test-fixtures/diagnostics.mjs', 'main.mjs', 'es'],
    ['src/preload/index.ts', 'preload.cjs', 'cjs'],
  ]) await build({ ...common, ssr: { noExternal: true, external: ['electron'] },
    build: { ssr: path.join(desktop, entry), outDir: directory, emptyOutDir: false, minify: false,
      rollupOptions: { external: ['electron'], output: { format, entryFileNames: output } } } })
  const html = await readFile(path.join(desktop, 'src/renderer/index.html'), 'utf8')
  await writeFile(path.join(directory, 'index.html'), html.replace('<script type="module" src="/src/main.tsx"></script>',
    '<div id="feedback"></div><link rel="stylesheet" href="./renderer.css"><script src="./renderer.js"></script>'))
  await writeFile(path.join(directory, 'start.mjs'), "import { app } from 'electron'; import('./main.mjs').catch(error => { process.stderr.write(String(error.stack)); app.exit(1) });")
  const env = { ...process.env, WHYCODE_DIAGNOSTICS_TEST_DIR: directory }
  delete env.ELECTRON_RUN_AS_NODE
  const { stdout } = await promisify(execFile)(require('electron'), [path.join(directory, 'start.mjs')], {
    env, windowsHide: true, timeout: 60_000, maxBuffer: 1_000_000,
  })
  assert.match(stdout, /diagnostics integration passed/)
})
