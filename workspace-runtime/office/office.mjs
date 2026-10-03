import { parseArgs } from 'node:util'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConverter, discoverRuntime } from '@deepseek-ai/libreoffice-kit'
import sharp from 'sharp'

let converter
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  input: { type: 'string' }, output: { type: 'string' }, 'output-dir': { type: 'string' },
  pages: { type: 'string' }, sheet: { type: 'string' }, range: { type: 'string' },
  dpi: { type: 'string', default: '144' }, 'timeout-ms': { type: 'string', default: '120000' },
  'font-directory': { type: 'string', multiple: true },
  } })
  const [command] = positionals
  if (positionals.length !== 1 || !['capabilities', 'render', 'convert', 'recalculate'].includes(command)) {
    throw new Error('Usage: office.mjs capabilities | render --input FILE --output-dir DIR [--pages 1,3] [--sheet NAME --range A1:D20] | convert --input FILE --output FILE | recalculate --input FILE --output FILE')
  }
  if (command === 'capabilities') {
    // 安装探测同时验证目标平台的图片处理二进制可用。
    await sharp({ create: { width: 1, height: 1, channels: 3, background: 'white' } }).png().toBuffer()
    console.log(JSON.stringify({ runtime: await discoverRuntime(), commands: ['render', 'convert', 'recalculate'], libraries: ['docx', 'pptxgenjs', 'exceljs', 'jszip', 'fast-xml-parser', 'sharp'] }))
  } else {
    if (!values.input) throw new Error('--input is required')
    const timeoutMs = Number(values['timeout-ms'])
    const dpi = Number(values.dpi)
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error('timeout-ms must be 1000–600000')
    if (!Number.isInteger(dpi) || dpi < 36 || dpi > 144) throw new Error('dpi must be 36–144')
    const controller = new AbortController()
    const cancel = () => controller.abort(new Error('Office command cancelled'))
    process.once('SIGINT', cancel)
    process.once('SIGTERM', cancel)
    // 缓存归环境所有，随受管组件一起清理，不落入引擎的全局默认缓存。
    converter = await createConverter({ timeoutMs, maxInputBytes: 100 * 1024 * 1024,
      maxOutputBytes: 100 * 1024 * 1024, maxArchiveEntries: 10000,
      maxUncompressedBytes: 250 * 1024 * 1024,
      fontMetadataCacheDirectory: join(dirname(fileURLToPath(import.meta.url)), 'cache'),
      ...(values['font-directory'] ? { fontDirectories: values['font-directory'].map(path => resolve(path)) } : {}),
    })
    const inputPath = resolve(values.input)
    let result
    if (command === 'render') {
      if (!values['output-dir'] || values.output) throw new Error('render requires --output-dir instead of --output')
      if (values.pages && !/^(all|[1-9]\d*(,[1-9]\d*)*)$/.test(values.pages)) throw new Error('pages must be all or page numbers separated by commas')
      result = await converter.renderImages({ inputPath, outputDir: resolve(values['output-dir']), dpi,
        ...(values.pages ? { pages: values.pages === 'all' ? 'all' : values.pages.split(',').map(Number) } : {}),
        ...(values.sheet ? { sheet: values.sheet } : {}), ...(values.range ? { range: values.range } : {}),
      }, controller.signal)
    } else {
      if (!values.output || values['output-dir'] || values.pages || values.range) throw new Error('convert/recalculate require --output and do not accept image selection options')
      if (command === 'recalculate' && values.sheet) throw new Error('recalculate operates on the entire workbook')
      const request = { inputPath, outputPath: resolve(values.output), ...(values.sheet ? { sheet: values.sheet } : {}) }
      result = await converter[command](request, controller.signal)
    }
    console.log(JSON.stringify(result))
  }
} catch (error) {
  console.error(JSON.stringify({ error: error.message, code: error.code ?? 'failed' }))
  process.exitCode = 1
} finally {
  await converter?.dispose()
}
