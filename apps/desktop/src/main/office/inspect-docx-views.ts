import type { OfficeInspectionUnit } from '@whycode/core/office'
import type { OfficeArchive } from './archive.ts'
import { readXml, sortedEntries } from './archive.ts'
import { attributeValue, boundedText, elementTexts, normalizeText } from './xml.ts'

export async function docxObjectUnits(archive: OfficeArchive): Promise<OfficeInspectionUnit[]> {
  const document = await readXml(archive, 'word/document.xml')
  const units: OfficeInspectionUnit[] = []
  addParagraphs(units, document)
  addTables(units, document)
  addDrawings(units, document)
  addSections(units, document)
  addRevisionSummary(units, document)
  await addStoryParts(units, archive)
  return reindex(units)
}

export async function docxStyleUnits(archive: OfficeArchive): Promise<OfficeInspectionUnit[]> {
  if (!archive.zip.file('word/styles.xml')) return []
  const xml = await readXml(archive, 'word/styles.xml')
  const units: OfficeInspectionUnit[] = []
  for (const match of xml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/gi)) {
    const attributes = match[1] ?? ''
    const body = match[2] ?? ''
    const id = attributeValue(attributes, 'w:styleId') ?? '(无 ID)'
    const type = attributeValue(attributes, 'w:type') ?? 'unknown'
    const nameAttributes = /<w:name\b([^>]*)\/?\s*>/i.exec(body)?.[1] ?? ''
    const basedOnAttributes = /<w:basedOn\b([^>]*)\/?\s*>/i.exec(body)?.[1] ?? ''
    const nextAttributes = /<w:next\b([^>]*)\/?\s*>/i.exec(body)?.[1] ?? ''
    const paragraphProperties = /<w:pPr\b[^>]*>([\s\S]*?)<\/w:pPr>/i.exec(body)?.[1] ?? ''
    const runProperties = /<w:rPr\b[^>]*>([\s\S]*?)<\/w:rPr>/i.exec(body)?.[1] ?? ''
    units.push({
      index: units.length + 1,
      label: `样式：${attributeValue(nameAttributes, 'w:val') ?? id}`,
      kind: 'style',
      locator: `word/styles.xml#style[${id}]`,
      text: [
        `ID：${id}；类型：${type}`,
        `继承：${attributeValue(basedOnAttributes, 'w:val') ?? '无'}；后续：${attributeValue(nextAttributes, 'w:val') ?? '无'}`,
        paragraphFormat(paragraphProperties),
        runFormat(runProperties),
        `表格属性：${hasTag(body, 'w:tblPr') ? '有' : '无'}`,
      ].join('\n'),
    })
  }
  return units
}

export async function docxTemplateUnits(archive: OfficeArchive): Promise<OfficeInspectionUnit[]> {
  const document = await readXml(archive, 'word/document.xml')
  const units: OfficeInspectionUnit[] = []
  addParagraphs(units, document)
  addTables(units, document)
  addDrawings(units, document)
  addSections(units, document)
  return reindex(units)
}

function addParagraphs(units: OfficeInspectionUnit[], document: string): void {
  let position = 0
  for (const match of document.matchAll(/<w:p\b([^>]*)>([\s\S]*?)<\/w:p>/gi)) {
    position++
    const body = match[2] ?? ''
    const text = normalizeText(elementTexts(body, 'w:t').join(' '))
    const styleAttributes = /<w:pStyle\b([^>]*)\/?\s*>/i.exec(body)?.[1] ?? ''
    const numAttributes = /<w:numId\b([^>]*)\/?\s*>/i.exec(body)?.[1] ?? ''
    const instructions = normalizeText(elementTexts(body, 'w:instrText').join(' '))
    const paragraphProperties = /<w:pPr\b[^>]*>([\s\S]*?)<\/w:pPr>/i.exec(body)?.[1] ?? ''
    const runProperties = /<w:rPr\b[^>]*>([\s\S]*?)<\/w:rPr>/i.exec(body)?.[1] ?? ''
    units.push({
      index: units.length + 1,
      label: `段落 ${position}`,
      kind: 'paragraph',
      locator: `word/document.xml#paragraph[${position}]`,
      text: boundedText([
        `样式：${attributeValue(styleAttributes, 'w:val') ?? '默认'}；编号：${attributeValue(numAttributes, 'w:val') ?? '无'}`,
        `分页：${hasTag(body, 'w:pageBreakBefore') || /<w:br\b[^>]*w:type=(?:"page"|'page')/i.test(body) ? '是' : '否'}；字段：${instructions || '无'}`,
        paragraphFormat(paragraphProperties),
        runFormat(runProperties),
        `文字：${text || '（空）'}`,
      ].join('\n'), 20_000),
    })
  }
}

function paragraphFormat(properties: string): string {
  const alignment = tagAttributes(properties, 'w:jc')
  const spacing = tagAttributes(properties, 'w:spacing')
  const indent = tagAttributes(properties, 'w:ind')
  return [
    `段落：对齐 ${attributeValue(alignment, 'w:val') ?? '继承'}`,
    `间距 前 ${attributeValue(spacing, 'w:before') ?? '继承'} / 后 ${attributeValue(spacing, 'w:after') ?? '继承'} / 行 ${attributeValue(spacing, 'w:line') ?? '继承'} ${attributeValue(spacing, 'w:lineRule') ?? ''}`.trim(),
    `缩进 左 ${attributeValue(indent, 'w:left') ?? '继承'} / 右 ${attributeValue(indent, 'w:right') ?? '继承'} / 首行 ${attributeValue(indent, 'w:firstLine') ?? '继承'} / 悬挂 ${attributeValue(indent, 'w:hanging') ?? '无'} twip`,
  ].join('；')
}

function runFormat(properties: string): string {
  const fonts = tagAttributes(properties, 'w:rFonts')
  const size = tagAttributes(properties, 'w:sz')
  const color = tagAttributes(properties, 'w:color')
  return [
    `文字：字体 ${attributeValue(fonts, 'w:eastAsia') ?? attributeValue(fonts, 'w:ascii') ?? '继承'}`,
    `字号 ${attributeValue(size, 'w:val') ?? '继承'} half-point`,
    `颜色 ${attributeValue(color, 'w:val') ?? '继承'}`,
    `粗体 ${hasTag(properties, 'w:b') ? '是' : '否'}`,
  ].join('；')
}

function tagAttributes(xml: string, tag: string): string {
  return new RegExp(`<${tag.replace(':', '\\:')}\\b([^>]*)`, 'i').exec(xml)?.[1] ?? ''
}

function addTables(units: OfficeInspectionUnit[], document: string): void {
  let position = 0
  for (const match of document.matchAll(/<w:tbl\b[^>]*>([\s\S]*?)<\/w:tbl>/gi)) {
    position++
    const body = match[1] ?? ''
    const rows = [...body.matchAll(/<w:tr\b/gi)].length
    const cells = [...body.matchAll(/<w:tc\b/gi)].length
    const styleAttributes = /<w:tblStyle\b([^>]*)\/?\s*>/i.exec(body)?.[1] ?? ''
    const widthAttributes = /<w:tblW\b([^>]*)\/?\s*>/i.exec(body)?.[1] ?? ''
    units.push({
      index: units.length + 1,
      label: `表格 ${position}`,
      kind: 'table',
      locator: `word/document.xml#table[${position}]`,
      text: boundedText([
        `行：${rows}；单元格：${cells}；样式：${attributeValue(styleAttributes, 'w:val') ?? '默认'}`,
        `声明宽度：${attributeValue(widthAttributes, 'w:w') ?? '自动'} ${attributeValue(widthAttributes, 'w:type') ?? ''}`.trim(),
        `文字：${normalizeText(elementTexts(body, 'w:t').join(' | ')) || '（空）'}`,
      ].join('\n'), 20_000),
    })
  }
}

function addDrawings(units: OfficeInspectionUnit[], document: string): void {
  let position = 0
  for (const match of document.matchAll(/<wp:(inline|anchor)\b[^>]*>([\s\S]*?)<\/wp:\1>/gi)) {
    position++
    const body = match[2] ?? ''
    const docPr = /<wp:docPr\b([^>]*)\/?\s*>/i.exec(body)?.[1] ?? ''
    const extent = /<wp:extent\b([^>]*)\/?\s*>/i.exec(body)?.[1] ?? ''
    const blip = /<a:blip\b([^>]*)\/?\s*>/i.exec(body)?.[1] ?? ''
    units.push({
      index: units.length + 1,
      label: `图形 ${position}：${attributeValue(docPr, 'name') ?? attributeValue(docPr, 'id') ?? '未命名'}`,
      kind: match[1]?.toLowerCase() === 'anchor' ? 'floating-drawing' : 'inline-drawing',
      locator: `word/document.xml#drawing[${position}]`,
      text: [
        `关系：${attributeValue(blip, 'r:embed') ?? attributeValue(blip, 'r:link') ?? '无'}`,
        `尺寸：${attributeValue(extent, 'cx') ?? '?'}×${attributeValue(extent, 'cy') ?? '?'} EMU`,
        `替代文字：${attributeValue(docPr, 'descr') ?? attributeValue(docPr, 'title') ?? '缺失'}`,
      ].join('\n'),
    })
  }
}

function addSections(units: OfficeInspectionUnit[], document: string): void {
  let position = 0
  for (const match of document.matchAll(/<w:sectPr\b[^>]*>([\s\S]*?)<\/w:sectPr>/gi)) {
    position++
    const body = match[1] ?? ''
    const size = /<w:pgSz\b([^>]*)\/?\s*>/i.exec(body)?.[1] ?? ''
    const margins = /<w:pgMar\b([^>]*)\/?\s*>/i.exec(body)?.[1] ?? ''
    units.push({
      index: units.length + 1,
      label: `节 ${position}`,
      kind: 'section',
      locator: `word/document.xml#section[${position}]`,
      text: [
        `页面：${attributeValue(size, 'w:w') ?? '?'}×${attributeValue(size, 'w:h') ?? '?'} twip；方向：${attributeValue(size, 'w:orient') ?? 'portrait'}`,
        `页边距：上 ${attributeValue(margins, 'w:top') ?? '?'}；右 ${attributeValue(margins, 'w:right') ?? '?'}；下 ${attributeValue(margins, 'w:bottom') ?? '?'}；左 ${attributeValue(margins, 'w:left') ?? '?'} twip`,
      ].join('\n'),
    })
  }
}

function addRevisionSummary(units: OfficeInspectionUnit[], document: string): void {
  const insertions = [...document.matchAll(/<w:ins\b/gi)].length
  const deletions = [...document.matchAll(/<w:del\b/gi)].length
  const fields = [...document.matchAll(/<w:fldSimple\b|<w:instrText\b/gi)].length
  if (insertions + deletions + fields === 0) return
  units.push({
    index: units.length + 1,
    label: '修订与字段摘要',
    kind: 'document-features',
    locator: 'word/document.xml',
    text: `插入修订 ${insertions}；删除修订 ${deletions}；字段 ${fields}`,
  })
}

async function addStoryParts(units: OfficeInspectionUnit[], archive: OfficeArchive): Promise<void> {
  const entries = sortedEntries(
    archive.zip,
    /^word\/(?:header\d+|footer\d+|comments|footnotes|endnotes)\.xml$/i,
  )
  for (const entry of entries) {
    const xml = await readXml(archive, entry.name)
    units.push({
      index: units.length + 1,
      label: storyLabel(entry.name),
      kind: storyKind(entry.name),
      locator: entry.name,
      text: boundedText(normalizeText(elementTexts(xml, 'w:t').join(' | ')) || '（空）', 20_000),
    })
  }
}

function storyKind(path: string): string {
  if (/header/i.test(path)) return 'header'
  if (/footer/i.test(path)) return 'footer'
  if (/comments/i.test(path)) return 'comments'
  if (/footnotes/i.test(path)) return 'footnotes'
  return 'endnotes'
}

function storyLabel(path: string): string {
  return `${storyKind(path)}：${path.split('/').at(-1)}`
}

function hasTag(xml: string, tag: string): boolean {
  return new RegExp(`<${tag.replace(':', '\\:')}\\b`, 'i').test(xml)
}

function reindex(units: OfficeInspectionUnit[]): OfficeInspectionUnit[] {
  return units.map((unit, position) => ({ ...unit, index: position + 1 }))
}
