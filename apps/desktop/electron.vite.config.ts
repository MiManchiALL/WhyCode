import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readdirSync, readFileSync } from 'node:fs'

const pdfRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
const pdfAssets = Object.fromEntries(Object.entries({ cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' }).map(([kind, directory]) => [
  kind, Object.fromEntries(readdirSync(join(pdfRoot, directory)).filter(name => !name.endsWith('.js') && name !== 'LICENSE').map(name => [name, readFileSync(join(pdfRoot, directory, name)).toString('base64')])),
]))

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: fileURLToPath(new URL('src/main/index.ts', import.meta.url)),
          'office-worker': fileURLToPath(new URL('src/main/office/worker.ts', import.meta.url)),
          'pdf-worker': fileURLToPath(new URL('src/main/pdf/worker.ts', import.meta.url)),
          'web-page-worker': fileURLToPath(new URL('src/main/web-page/worker.ts', import.meta.url)),
        },
        output: { entryFileNames: '[name].js' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // sandbox 开启时 Electron 的 preload 只支持 CJS，强制 .cjs 产物
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    define: { __WHYCODE_PDF_ASSETS__: JSON.stringify(pdfAssets) },
    plugins: [react(), tailwindcss()],
  },
})
