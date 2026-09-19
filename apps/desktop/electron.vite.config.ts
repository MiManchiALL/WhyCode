import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
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
    worker: { format: 'es' },
    optimizeDeps: {
      // Worker 不在 HTML 导入图中；提前扫描可避免首次展开代码时重新预构建并刷新页面。
      entries: ['index.html', 'src/syntax-highlight.worker.ts'],
    },
    plugins: [react(), tailwindcss()],
  },
})
