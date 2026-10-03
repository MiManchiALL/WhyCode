import { registerHooks } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const usage = 'Usage: node run.mjs <script.mjs> [arguments]\nWrite JavaScript to a .mjs file, then pass its path. Node flags such as -e/--eval are not supported; bundled libraries are resolved for the script.'
const script = process.argv[2]
if (!script || script.startsWith('-')) {
  if (script === '--help') console.log(usage)
  else console.error(`${script ? `Unsupported option: ${script}\n` : ''}${usage}`)
  process.exit(script === '--help' ? 0 : 1)
}

// 工作脚本留在项目内；只把随环境发布的库解析到受管目录。
const libraries = new Set(['docx', 'exceljs', 'pptxgenjs', 'jszip', 'fast-xml-parser', 'sharp'])
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier, libraries.has(specifier) ? { ...context, parentURL: import.meta.url } : context)
  },
})
process.argv.splice(1, 1)
await import(pathToFileURL(resolve(script)).href)
