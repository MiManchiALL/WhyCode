import { readXml } from './archive.ts'
import type { ValidationState } from './validation-state.ts'
import { validationIssue } from './validation-state.ts'
import { attributeValue, elementTexts, normalizeText } from './xml.ts'

export async function validateDocxPackage(state: ValidationState): Promise<void> {
  const document = await readXml(state.archive, 'word/document.xml')
  validatePairedIds(state, document, 'w:bookmarkStart', 'w:bookmarkEnd', 'w:id', 'bookmark')
  validatePairedIds(state, document, 'w:commentRangeStart', 'w:commentRangeEnd', 'w:id', 'comment-range')
  await validateReferenceDefinitions(state, document, {
    referenceTag: 'w:footnoteReference', definitionPart: 'word/footnotes.xml',
    definitionTag: 'w:footnote', code: 'footnote',
  })
  await validateReferenceDefinitions(state, document, {
    referenceTag: 'w:endnoteReference', definitionPart: 'word/endnotes.xml',
    definitionTag: 'w:endnote', code: 'endnote',
  })
  await validateComments(state, document)
  await validateNumbering(state, document)
  await validateStyleReferences(state, document)
  validateRevisions(state, document)
  validateDocxLayout(state, document)
}

async function validateNumbering(state: ValidationState, document: string): Promise<void> {
  const references = tagIds(document, 'w:numId', 'w:val')
  references.delete('0')
  if (references.size === 0) return
  if (!state.archive.zip.file('word/numbering.xml')) {
    validationIssue(state, 'numbering-part-missing', 'error', 'word/document.xml', '正文使用编号但没有 numbering.xml')
    return
  }
  const definitions = tagIds(
    await readXml(state.archive, 'word/numbering.xml'),
    'w:num',
    'w:numId',
  )
  for (const id of references) {
    if (!definitions.has(id)) {
      validationIssue(state, 'numbering-definition-missing', 'error', 'word/document.xml', `编号 ${id} 没有定义`)
    }
  }
}

async function validateStyleReferences(state: ValidationState, document: string): Promise<void> {
  if (!state.archive.zip.file('word/styles.xml')) return
  const styles = tagIds(await readXml(state.archive, 'word/styles.xml'), 'w:style', 'w:styleId')
  for (const tag of ['w:pStyle', 'w:rStyle', 'w:tblStyle']) {
    for (const id of tagIds(document, tag, 'w:val')) {
      if (!styles.has(id)) {
        validationIssue(state, 'docx-style-reference', 'warning', 'word/document.xml', `${tag} 引用了未定义样式：${id}`)
      }
    }
  }
}

function validateRevisions(state: ValidationState, document: string): void {
  for (const match of document.matchAll(/<w:(?:ins|del)\b([^>]*)>/gi)) {
    const attributes = match[1] ?? ''
    if (!attributeValue(attributes, 'w:id') || !attributeValue(attributes, 'w:author')) {
      validationIssue(state, 'revision-metadata', 'error', 'word/document.xml', '修订缺少 w:id 或 w:author')
    }
  }
}

async function validateComments(state: ValidationState, document: string): Promise<void> {
  const anchors = tagIds(document, 'w:commentReference', 'w:id')
  if (anchors.size === 0) return
  if (!state.archive.zip.file('word/comments.xml')) {
    validationIssue(state, 'comments-part-missing', 'error', 'word/document.xml', '存在批注锚点但没有 comments.xml')
    return
  }
  const definitions = tagIds(await readXml(state.archive, 'word/comments.xml'), 'w:comment', 'w:id')
  for (const id of anchors) {
    if (!definitions.has(id)) {
      validationIssue(state, 'comment-definition-missing', 'error', 'word/document.xml', `批注 ${id} 没有定义`)
    }
  }
}

function validateDocxLayout(state: ValidationState, document: string): void {
  const usableWidths: number[] = []
  for (const match of document.matchAll(/<w:sectPr\b[^>]*>([\s\S]*?)<\/w:sectPr>/gi)) {
    const body = match[1] ?? ''
    const size = /<w:pgSz\b([^>]*)\/?\s*>/i.exec(body)?.[1] ?? ''
    const margins = /<w:pgMar\b([^>]*)\/?\s*>/i.exec(body)?.[1] ?? ''
    const width = numberAttribute(size, 'w:w')
    const left = numberAttribute(margins, 'w:left')
    const right = numberAttribute(margins, 'w:right')
    if (width > 0 && left + right < width) usableWidths.push(width - left - right)
    else validationIssue(state, 'docx-page-geometry', 'warning', 'word/document.xml', '页面宽度或左右页边距无效')
  }
  const usableWidth = usableWidths.length > 0 ? Math.min(...usableWidths) : 9_360
  let tableIndex = 0
  for (const match of document.matchAll(/<w:tbl\b[^>]*>([\s\S]*?)<\/w:tbl>/gi)) {
    tableIndex++
    const widthAttributes = /<w:tblW\b([^>]*)\/?\s*>/i.exec(match[1] ?? '')?.[1] ?? ''
    if (attributeValue(widthAttributes, 'w:type') === 'dxa') {
      const width = numberAttribute(widthAttributes, 'w:w')
      if (width > usableWidth * 1.02) {
        validationIssue(state, 'docx-table-width', 'warning', `word/document.xml#table[${tableIndex}]`, `表格声明宽度 ${width} twip 超过可用页宽 ${usableWidth} twip`)
      }
    }
  }
  let drawingIndex = 0
  for (const match of document.matchAll(/<wp:docPr\b([^>]*)\/?\s*>/gi)) {
    drawingIndex++
    const attributes = match[1] ?? ''
    if (!attributeValue(attributes, 'descr') && !attributeValue(attributes, 'title')) {
      validationIssue(state, 'docx-image-alt-text', 'warning', `word/document.xml#drawing[${drawingIndex}]`, '图形缺少替代文字')
    }
  }
  validateHeadingOrder(state, document)
}

function validateHeadingOrder(state: ValidationState, document: string): void {
  let previous = 0
  let paragraph = 0
  for (const match of document.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/gi)) {
    paragraph++
    const body = match[1] ?? ''
    const style = attributeValue(/<w:pStyle\b([^>]*)\/?\s*>/i.exec(body)?.[1] ?? '', 'w:val') ?? ''
    const level = /^(?:heading|标题)([1-9])$/i.exec(style)?.[1]
    if (!level) continue
    const current = Number(level)
    if (previous > 0 && current > previous + 1) {
      const text = normalizeText(elementTexts(body, 'w:t').join(' '))
      validationIssue(state, 'docx-heading-order', 'warning', `word/document.xml#paragraph[${paragraph}]`, `标题层级从 ${previous} 跳到 ${current}${text ? `：${text.slice(0, 80)}` : ''}`)
    }
    previous = current
  }
}

function validatePairedIds(
  state: ValidationState,
  xml: string,
  startTag: string,
  endTag: string,
  attribute: string,
  code: string,
): void {
  const starts = tagIds(xml, startTag, attribute)
  const ends = tagIds(xml, endTag, attribute)
  for (const id of starts) {
    if (!ends.has(id)) validationIssue(state, `${code}-end`, 'error', 'word/document.xml', `${code} ${id} 缺少结束标记`)
  }
  for (const id of ends) {
    if (!starts.has(id)) validationIssue(state, `${code}-start`, 'error', 'word/document.xml', `${code} ${id} 缺少开始标记`)
  }
}

async function validateReferenceDefinitions(
  state: ValidationState,
  document: string,
  options: { referenceTag: string; definitionPart: string; definitionTag: string; code: string },
): Promise<void> {
  const references = tagIds(document, options.referenceTag, 'w:id')
  if (references.size === 0) return
  if (!state.archive.zip.file(options.definitionPart)) {
    validationIssue(state, `${options.code}-part`, 'error', 'word/document.xml', `${options.code} 引用没有定义部件`)
    return
  }
  const definitions = tagIds(await readXml(state.archive, options.definitionPart), options.definitionTag, 'w:id')
  for (const id of references) {
    if (!definitions.has(id)) validationIssue(state, `${options.code}-definition`, 'error', 'word/document.xml', `${options.code} ${id} 没有定义`)
  }
}

function tagIds(xml: string, tag: string, attribute: string): Set<string> {
  const ids = new Set<string>()
  const expression = new RegExp(`<${tag.replace(':', '\\:')}\\b([^>]*)>`, 'gi')
  for (const match of xml.matchAll(expression)) {
    const id = attributeValue(match[1] ?? '', attribute)
    if (id) ids.add(id)
  }
  return ids
}

function numberAttribute(attributes: string, name: string): number {
  const value = attributeValue(attributes, name)
  return value && /^\d+$/.test(value) ? Number(value) : 0
}
