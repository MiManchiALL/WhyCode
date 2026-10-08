import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const desktop = path.resolve(import.meta.dirname, '../../..')

test('正式 CSP 下的新建和已存储网页引用都能还原截图', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY,
}, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'whycode-reference-test-'))
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()))
    assert.ok(path.basename(directory).startsWith('whycode-reference-test-'))
    await rm(directory, { recursive: true, force: true })
  })
  const common = { configFile: false, root: desktop, logLevel: 'silent' }
  await build({
    ...common,
    build: {
      outDir: directory, emptyOutDir: false, minify: false,
      lib: {
        entry: path.join(desktop, 'src/renderer/src/browser-reference-image.ts'),
        name: 'BrowserReferenceImage', formats: ['iife'], fileName: () => 'renderer.js',
      },
    },
  })
  await build({
    ...common,
    build: {
      ssr: path.join(desktop, 'src/main/test-fixtures/browser-reference-image.mjs'),
      outDir: directory, emptyOutDir: false, minify: false,
      rollupOptions: {
        external: ['electron', '@whycode/core'],
        output: {
          entryFileNames: 'main.mjs',
          paths: { '@whycode/core': pathToFileURL(require.resolve('@whycode/core')).href },
        },
      },
    },
  })
  // 直接使用主界面的 CSP，避免隔离用例遗漏真实的资源加载边界。
  const html = await readFile(path.join(desktop, 'src/renderer/index.html'), 'utf8')
  const fixture = html.replace('<script type="module" src="/src/main.tsx"></script>', '<script src="./renderer.js"></script>')
  assert.notEqual(fixture, html)
  await writeFile(path.join(directory, 'index.html'), fixture)
  const env = { ...process.env, WHYCODE_REFERENCE_TEST_DIR: directory }
  delete env.ELECTRON_RUN_AS_NODE
  const { stdout } = await promisify(execFile)(require('electron'), [path.join(directory, 'main.mjs')], {
    env, windowsHide: true, timeout: 60_000,
  })
  assert.match(stdout, /reference images passed/)
})
