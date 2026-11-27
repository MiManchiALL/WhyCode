import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { build } from 'vite'

const desktop = path.resolve(import.meta.dirname, '../../..')
test('后台任务菜单按会话清空已结束的行，保留活动任务并接收后续终态', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY,
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'whycode-task-menu-'))
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()))
    assert.ok(path.basename(directory).startsWith('whycode-task-menu-'))
    await rm(directory, { recursive: true, force: true })
  })
  await build({
    configFile: false, root: desktop, logLevel: 'silent', plugins: [react(), tailwindcss()],
    define: { 'process.env.NODE_ENV': '"production"' },
    build: { outDir: directory, emptyOutDir: false, lib: {
      entry: path.join(import.meta.dirname, 'test-fixtures/background-task-menu.tsx'),
      name: 'TaskMenuFixture', formats: ['iife'], fileName: () => 'renderer.js', cssFileName: 'renderer',
    } },
  })
  await writeFile(path.join(directory, 'index.html'),
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><div id="root"></div><script src="renderer.js"></script>')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const electron = createRequire(import.meta.url)('electron')
  const result = await promisify(execFile)(electron, [path.join(desktop, 'src/main/test-fixtures/background-task-menu.mjs'), directory], {
    env, windowsHide: true, timeout: 45_000,
  })
  assert.match(result.stdout, /background task menu passed/)
})
