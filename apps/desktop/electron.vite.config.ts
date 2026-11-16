import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { LANGUAGE_LOADERS } from './src/renderer/src/syntax-highlight-languages.ts'
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: fileURLToPath(new URL('src/main/index.ts', import.meta.url)),
          'pdf-worker': fileURLToPath(new URL('src/main/pdf/worker.ts', import.meta.url)),
          'web-page-worker': fileURLToPath(new URL('src/main/web-page/worker.ts', import.meta.url)),
          'windows-screenshot-worker': fileURLToPath(new URL('src/main/windows-screenshot-worker.ts', import.meta.url)),
        },
        output: { entryFileNames: '[name].js' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: fileURLToPath(new URL('src/preload/index.ts', import.meta.url)),
          browser: fileURLToPath(new URL('src/preload/browser.ts', import.meta.url)),
        },
        // sandbox 开启时 Electron 的 preload 只支持 CJS，强制 .cjs 产物
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    worker: { format: 'es' },
    optimizeDeps: {
      // Worker 不在 HTML 导入图中，启动时一并扫描高亮引擎和主题。
      entries: ['index.html', 'src/syntax-highlight.worker.ts'],
      // 语法清单参与缓存键，增删语言时 Vite 会在启动阶段重新预构建。
      include: Object.keys(LANGUAGE_LOADERS).map(language => `shiki/langs/${language}.mjs`),
    },
    plugins: [react(), tailwindcss()],
  },
})
