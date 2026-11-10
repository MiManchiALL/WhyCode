import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { createServer } from 'vite'
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
  const entry = '/src/renderer/src/test-fixtures/code-review.tsx'
  const server = await createServer({
    root: desktop, configFile: false, cacheDir: path.join(directory, 'vite'), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, appType: 'custom',
    optimizeDeps: { entries: [entry.slice(1), 'src/renderer/src/syntax-highlight.worker.ts'] },
    plugins: [react(), tailwindcss(), { name: 'code-review-fixture', configureServer(vite) {
      vite.middlewares.use('/fixture', (_req, res, next) => {
        const html = `<meta charset="utf-8"><div id="root"></div><script type="module" src="${entry}"></script>`
        void vite.transformIndexHtml('/fixture', html).then(page => {
          res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(page)
        }, next)
      })
    } }],
  })
  try {
    await server.listen()
    const env = { ...process.env, WHYCODE_REVIEW_TEST_DIR: directory, WHYCODE_REVIEW_TEST_URL: new URL('fixture', server.resolvedUrls.local[0]).href }
    delete env.ELECTRON_RUN_AS_NODE
    const { stdout } = await promisify(execFile)(require('electron'), [path.join(desktop, 'src/main/test-fixtures/code-review.mjs')],
      { env, windowsHide: true, timeout: 90_000 })
    assert.match(stdout, /code review passed/)
  } finally { await server.close() }
})
