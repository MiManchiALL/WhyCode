import JSZip from 'jszip'
import { OfficeProcessingError } from '@whycode/core/office'

interface ParagraphSpan {
  end: number
  index: number
  start: number
  tableDepth: number
  xml: string
}

interface ParagraphBlock {
  pageBreakBefore: boolean
  sourceLocator: string
  text: string
}

interface ParagraphRangeEdit {
  blocks: ParagraphBlock[]
  endLocator: string
  startLocator: string
}

interface ParagraphTextEdit {
  locator: string
  text: string
}

interface DocxTemplatePlan {
  rangeEdits: ParagraphRangeEdit[]
  template: Uint8Array
  textEdits: ParagraphTextEdit[]
}

const PARAGRAPH_LOCATOR = /^word\/document\.xml#paragraph\[(\d+)\]$/u
const MAX_EDITS = 1_000
const MAX_TEXT_CHARS = 2_000_000

export async function editDocxTemplate(value: unknown): Promise<Uint8Array> {
  const plan = parsePlan(value)
  const zip = await JSZip.loadAsync(plan.template)
  const entry = zip.file('word/document.xml')
  if (!entry) throw new OfficeProcessingError('corrupted', 'DOCX 模板缺少 word/document.xml')
  const document = await entry.async('string')
  const paragraphs = paragraphSpans(document)
  const operations = buildOperations(document, paragraphs, plan)
  let output = document
  for (const operation of operations.sort((left, right) => right.start - left.start)) {
    output = `${output.slice(0, operation.start)}${operation.value}${output.slice(operation.end)}`
  }
  zip.file('word/document.xml', output)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

function parsePlan(value: unknown): DocxTemplatePlan {
  const input = record(value, 'OfficeTemplate.docx 参数必须是对象')
  const template = bytes(input.template, 'OfficeTemplate.docx.template 必须是模板 bytes')
  const textEdits = array(input.textEdits ?? [], 'textEdits').map((entry) => {
    const edit = record(entry, 'textEdits 项必须是对象')
    return { locator: locator(edit.locator), text: text(edit.text) }
  })
  const rangeEdits = array(input.rangeEdits ?? [], 'rangeEdits').map((entry) => {
    const edit = record(entry, 'rangeEdits 项必须是对象')
    const blocks = array(edit.blocks, 'rangeEdits.blocks').map((block) => {
      const item = record(block, 'rangeEdits.blocks 项必须是对象')
      return {
        sourceLocator: locator(item.sourceLocator),
        text: text(item.text),
        pageBreakBefore: item.pageBreakBefore === true,
      }
    })
    if (blocks.length === 0) throw new OfficeProcessingError('corrupted', 'rangeEdits.blocks 不能为空')
    return {
      startLocator: locator(edit.startLocator),
      endLocator: locator(edit.endLocator),
      blocks,
    }
  })
  if (textEdits.length + rangeEdits.length > MAX_EDITS) {
    throw new OfficeProcessingError('too-large', `DOCX 模板编辑最多 ${MAX_EDITS} 项`)
  }
  const totalChars = [
    ...textEdits.map((edit) => edit.text.length),
    ...rangeEdits.flatMap((edit) => edit.blocks.map((block) => block.text.length)),
  ].reduce((total, size) => total + size, 0)
  if (totalChars > MAX_TEXT_CHARS) {
    throw new OfficeProcessingError('too-large', 'DOCX 模板编辑文字超过 200 万字符')
  }
  return { template, textEdits, rangeEdits }
}

function buildOperations(
  document: string,
  paragraphs: readonly ParagraphSpan[],
  plan: DocxTemplatePlan,
): Array<{ start: number; end: number; value: string }> {
  const operations = plan.textEdits.map((edit) => {
    const paragraph = paragraphAt(paragraphs, edit.locator)
    return { start: paragraph.start, end: paragraph.end, value: replaceParagraphText(paragraph.xml, edit.text) }
  })
  for (const edit of plan.rangeEdits) {
    const start = paragraphAt(paragraphs, edit.startLocator)
    const end = paragraphAt(paragraphs, edit.endLocator)
    if (start.index > end.index) {
      throw new OfficeProcessingError('invalid-range', 'DOCX 模板段落范围起点不能晚于终点')
    }
    if (start.tableDepth > 0 || end.tableDepth > 0) {
      throw new OfficeProcessingError('invalid-range', 'DOCX 模板段落范围不能从表格内部开始或结束')
    }
    const value = edit.blocks.map((block) => {
      const source = paragraphAt(paragraphs, block.sourceLocator)
      const replaced = replaceParagraphText(source.xml, block.text)
      return block.pageBreakBefore ? withPageBreakBefore(replaced) : replaced
    }).join('')
    operations.push({ start: start.start, end: end.end, value })
  }
  const ordered = [...operations].sort((left, right) => left.start - right.start)
  for (let index = 1; index < ordered.length; index++) {
    if (ordered[index]!.start < ordered[index - 1]!.end) {
      throw new OfficeProcessingError('invalid-range', 'DOCX 模板编辑范围彼此重叠')
    }
  }
  if (!document.includes('<w:body')) throw new OfficeProcessingError('corrupted', 'DOCX 正文缺少 w:body')
  return operations
}

function paragraphSpans(xml: string): ParagraphSpan[] {
  const tableEvents = [...xml.matchAll(/<\/?w:tbl\b[^>]*>/gi)]
  let eventPosition = 0
  let tableDepth = 0
  const paragraphs: ParagraphSpan[] = []
  for (const match of xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/gi)) {
    const start = match.index
    while ((tableEvents[eventPosition]?.index ?? Number.POSITIVE_INFINITY) < start) {
      const token = tableEvents[eventPosition]![0]
      tableDepth += token.startsWith('</') ? -1 : 1
      eventPosition++
    }
    paragraphs.push({
      index: paragraphs.length + 1,
      start,
      end: start + match[0].length,
      tableDepth,
      xml: match[0],
    })
  }
  return paragraphs
}

function paragraphAt(paragraphs: readonly ParagraphSpan[], value: string): ParagraphSpan {
  const index = Number(PARAGRAPH_LOCATOR.exec(value)?.[1])
  const paragraph = paragraphs[index - 1]
  if (!paragraph) throw new OfficeProcessingError('invalid-range', `DOCX 模板不存在定位：${value}`)
  return paragraph
}

function replaceParagraphText(paragraph: string, value: string): string {
  let seen = false
  const replaced = paragraph.replace(/<w:t\b([^>]*)>[\s\S]*?<\/w:t>/gi, (_match, attributes: string) => {
    if (seen) return `<w:t${attributes}></w:t>`
    seen = true
    const normalized = preserveSpaceAttribute(attributes, value)
    return `<w:t${normalized}>${escapeXml(value)}</w:t>`
  })
  if (seen) return replaced
  return paragraph.replace(/<\/w:p>$/i, `<w:r><w:t${spaceAttribute(value)}>${escapeXml(value)}</w:t></w:r></w:p>`)
}

function withPageBreakBefore(paragraph: string): string {
  if (/<w:pageBreakBefore\b/i.test(paragraph)) return paragraph
  if (/<w:pPr\b[^>]*>/i.test(paragraph)) {
    return paragraph.replace(/<\/w:pPr>/i, '<w:pageBreakBefore/></w:pPr>')
  }
  return paragraph.replace(/^(<w:p\b[^>]*>)/i, '$1<w:pPr><w:pageBreakBefore/></w:pPr>')
}

function preserveSpaceAttribute(attributes: string, value: string): string {
  const without = attributes.replace(/\s+xml:space=(?:"[^"]*"|'[^']*')/giu, '')
  return `${without}${spaceAttribute(value)}`
}

function spaceAttribute(value: string): string {
  return /^\s|\s$/u.test(value) ? ' xml:space="preserve"' : ''
}

function locator(value: unknown): string {
  if (typeof value !== 'string' || !PARAGRAPH_LOCATOR.test(value)) {
    throw new OfficeProcessingError('corrupted', 'DOCX 模板段落定位格式无效')
  }
  return value
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\u0000')) {
    throw new OfficeProcessingError('corrupted', 'DOCX 模板编辑文字无效')
  }
  return value
}

function bytes(value: unknown, message: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new OfficeProcessingError('corrupted', message)
  }
  return value
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new OfficeProcessingError('corrupted', `${name} 必须是数组`)
  return value
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OfficeProcessingError('corrupted', message)
  }
  return value as Record<string, unknown>
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
