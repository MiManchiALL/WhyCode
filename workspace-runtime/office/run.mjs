import { registerHooks } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// 工作脚本留在项目内；只把随环境发布的库解析到受管目录。
const libraries = new Set(['docx', 'exceljs', 'pptxgenjs', 'jszip', 'fast-xml-parser', 'sharp'])
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier, libraries.has(specifier) ? { ...context, parentURL: import.meta.url } : context)
  },
})
const script = process.argv[2]
if (!script) throw new Error('Usage: node run.mjs <project-script.mjs> [arguments]')
process.argv.splice(1, 1)
await import(pathToFileURL(resolve(script)).href)
