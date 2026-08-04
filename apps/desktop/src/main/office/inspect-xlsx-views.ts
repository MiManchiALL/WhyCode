import { posix } from 'node:path'
import {
  OfficeProcessingError,
  type OfficeInspectionUnit,
} from '@whycode/core/office'
import type { OfficeArchive } from './archive.ts'
import { readXml } from './archive.ts'
import { readRelationships, relationshipTarget } from './relationships.ts'
import { attributeValue, boundedText, elementTexts, normalizeText } from './xml.ts'
import {
  type WorkbookDefinedName,
  type WorkbookSheet,
  type WorksheetCell,
  type WorksheetSummary,
} from './xlsx-package.ts'
import {
  cellInRange,
  columnName,
  parseCellRange,
  type CellRange,
} from './xlsx-references.ts'

export async function xlsxObjectUnits(options: {
  archive: OfficeArchive
  sheets: readonly WorkbookSheet[]
  summaries: ReadonlyMap<string, WorksheetSummary>
  sheetName?: string
  range?: string
  definedNames: readonly WorkbookDefinedName[]
}): Promise<OfficeInspectionUnit[]> {
  const selectedSheets = selectSheets(options.sheets, options.sheetName)
  const range = requireRange(options.range)
  const units: OfficeInspectionUnit[] = []
  addDefinedNames(units, options.definedNames, options.sheetName)
  for (const sheet of selectedSheets) {
    const xml = await readXml(options.archive, sheet.path)
    addWorksheetSettings(units, sheet, xml)
    addCells(units, sheet, options.summaries.get(sheet.name)!, range)
    addWorksheetRules(units, sheet, xml)
    await addRelatedObjects(units, options.archive, sheet)
  }
  return reindex(units)
}

function addDefinedNames(
  units: OfficeInspectionUnit[],
  names: readonly WorkbookDefinedName[],
  sheetName?: string,
): void {
  for (const name of names) {
    if (sheetName && name.localSheetName && name.localSheetName !== sheetName) continue
    units.push({
      index: units.length + 1,
      label: `名称：${name.name}`,
      kind: 'defined-name',
      locator: `xl/workbook.xml#definedName[${name.name}]`,
      text: `作用域：${name.localSheetName ?? '工作簿'}；隐藏：${name.hidden ? '是' : '否'}；表达式：${name.expression || '（空）'}`,
    })
  }
}

export async function xlsxStyleUnits(archive: OfficeArchive): Promise<OfficeInspectionUnit[]> {
  if (!archive.zip.file('xl/styles.xml')) return []
  const xml = await readXml(archive, 'xl/styles.xml')
  const numberFormats = new Map<string, string>()
  for (const match of xml.matchAll(/<numFmt\b([^>]*)\/?\s*>/gi)) {
    const id = attributeValue(match[1] ?? '', 'numFmtId')
    const code = attributeValue(match[1] ?? '', 'formatCode')
    if (id && code) numberFormats.set(id, code)
  }
  const fonts = countCollection(xml, 'fonts', 'font')
  const fills = countCollection(xml, 'fills', 'fill')
  const borders = countCollection(xml, 'borders', 'border')
  const body = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/i.exec(xml)?.[1] ?? ''
  const units: OfficeInspectionUnit[] = []
  for (const match of body.matchAll(/<xf\b([^>]*)(?:\/>|>([\s\S]*?)<\/xf>)/gi)) {
    const attributes = match[1] ?? ''
    const id = units.length
    const numberFormatId = attributeValue(attributes, 'numFmtId') ?? '0'
    units.push({
      index: id + 1,
      label: `单元格样式 ${id}`,
      kind: 'cell-style',
      locator: `xl/styles.xml#cellXfs[${id}]`,
      text: [
        `字体 ${attributeValue(attributes, 'fontId') ?? '0'}/${fonts}；填充 ${attributeValue(attributes, 'fillId') ?? '0'}/${fills}；边框 ${attributeValue(attributes, 'borderId') ?? '0'}/${borders}`,
        `数字格式 ${numberFormatId}${numberFormats.has(numberFormatId) ? `：${numberFormats.get(numberFormatId)}` : ''}`,
        `对齐：${/<alignment\b/i.test(match[2] ?? '') ? '自定义' : '默认'}；保护：${/<protection\b/i.test(match[2] ?? '') ? '自定义' : '默认'}`,
      ].join('\n'),
    })
  }
  return units
}

function addWorksheetSettings(
  units: OfficeInspectionUnit[],
  sheet: WorkbookSheet,
  xml: string,
): void {
  const pane = /<pane\b([^>]*)\/?\s*>/i.exec(xml)?.[1] ?? ''
  const filter = /<autoFilter\b([^>]*)\/?\s*>/i.exec(xml)?.[1] ?? ''
  const dimension = /<dimension\b([^>]*)\/?\s*>/i.exec(xml)?.[1] ?? ''
  const merges = [...xml.matchAll(/<mergeCell\b/gi)].length
  const hiddenRows = [...xml.matchAll(/<row\b[^>]*\bhidden=(?:"1"|'1')/gi)].length
  const hiddenColumns = [...xml.matchAll(/<col\b[^>]*\bhidden=(?:"1"|'1')/gi)].length
  units.push({
    index: units.length + 1,
    label: `工作表设置：${sheet.name}`,
    kind: 'worksheet-settings',
    locator: sheet.path,
    text: [
      `使用区域：${attributeValue(dimension, 'ref') ?? '未声明'}；合并区域：${merges}`,
      `冻结/拆分：${attributeValue(pane, 'state') ?? '无'}；顶部左侧：${attributeValue(pane, 'topLeftCell') ?? '无'}`,
      `自动筛选：${attributeValue(filter, 'ref') ?? '无'}；隐藏行：${hiddenRows}；隐藏列：${hiddenColumns}`,
    ].join('\n'),
  })
}

function addCells(
  units: OfficeInspectionUnit[],
  sheet: WorkbookSheet,
  summary: WorksheetSummary,
  range: CellRange | null,
): void {
  for (const cell of summary.cells) {
    if (range && !cellInRange(cell, range)) continue
    units.push({
      index: units.length + 1,
      label: `${sheet.name}!${cell.reference}`,
      kind: cell.hasFormula ? 'formula-cell' : 'cell',
      locator: `${sheet.path}#cell[${cell.reference}]`,
      text: [
        `类型：${cell.type || 'number/general'}；样式：${cell.styleIndex ?? 0}`,
        `公式：${cell.hasFormula ? cell.formula || '共享公式' : '无'}`,
        `已保存值：${cell.value || '无'}；缓存：${cell.hasFormula ? cell.hasCachedValue ? '有' : '缺失' : '不适用'}`,
      ].join('\n'),
    })
  }
}

function addWorksheetRules(
  units: OfficeInspectionUnit[],
  sheet: WorkbookSheet,
  xml: string,
): void {
  for (const match of xml.matchAll(/<mergeCell\b([^>]*)\/?\s*>/gi)) {
    const reference = attributeValue(match[1] ?? '', 'ref') ?? '未知'
    units.push({
      index: units.length + 1,
      label: `合并区域：${sheet.name}!${reference}`,
      kind: 'merged-range',
      locator: `${sheet.path}#merge[${reference}]`,
      text: `范围：${reference}`,
    })
  }
  for (const [tag, kind] of [['conditionalFormatting', 'conditional-format'], ['dataValidation', 'data-validation']] as const) {
    const expression = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi')
    for (const match of xml.matchAll(expression)) {
      const reference = attributeValue(match[1] ?? '', 'sqref') ?? '未声明'
      const formulas = normalizeText(elementTexts(match[2] ?? '', 'formula1').concat(elementTexts(match[2] ?? '', 'formula2')).join(' | '))
      units.push({
        index: units.length + 1,
        label: `${kind === 'conditional-format' ? '条件格式' : '数据验证'}：${sheet.name}!${reference}`,
        kind,
        locator: `${sheet.path}#${kind}[${reference}]`,
        text: `范围：${reference}；规则：${boundedText(formulas || '见 OOXML 属性', 10_000)}`,
      })
    }
  }
}

async function addRelatedObjects(
  units: OfficeInspectionUnit[],
  archive: OfficeArchive,
  sheet: WorkbookSheet,
): Promise<void> {
  const relationshipsPath = `${posix.dirname(sheet.path)}/_rels/${posix.basename(sheet.path)}.rels`
  if (!archive.zip.file(relationshipsPath)) return
  for (const relationship of await readRelationships(archive, relationshipsPath)) {
    if (relationship.external) continue
    const path = relationshipTarget(relationshipsPath, relationship.target)
    if (relationship.type.endsWith('/table')) await addTable(units, archive, sheet, path)
    else if (relationship.type.endsWith('/drawing')) await addDrawing(units, archive, sheet, path)
    else if (relationship.type.endsWith('/comments')) await addComments(units, archive, sheet, path)
  }
}

async function addTable(
  units: OfficeInspectionUnit[], archive: OfficeArchive, sheet: WorkbookSheet, path: string,
): Promise<void> {
  const xml = await readXml(archive, path)
  const attributes = /<table\b([^>]*)>/i.exec(xml)?.[1] ?? ''
  const name = attributeValue(attributes, 'displayName') ?? attributeValue(attributes, 'name') ?? posix.basename(path)
  units.push({
    index: units.length + 1,
    label: `表：${name}`,
    kind: 'table',
    locator: path,
    text: `工作表：${sheet.name}；范围：${attributeValue(attributes, 'ref') ?? '未声明'}；列数：${[...xml.matchAll(/<tableColumn\b/gi)].length}`,
  })
}

async function addDrawing(
  units: OfficeInspectionUnit[], archive: OfficeArchive, sheet: WorkbookSheet, path: string,
): Promise<void> {
  const xml = await readXml(archive, path)
  let position = 0
  for (const match of xml.matchAll(/<xdr:(?:twoCellAnchor|oneCellAnchor|absoluteAnchor)\b[^>]*>([\s\S]*?)<\/xdr:(?:twoCellAnchor|oneCellAnchor|absoluteAnchor)>/gi)) {
    position++
    const body = match[1] ?? ''
    const name = attributeValue(/<xdr:cNvPr\b([^>]*)/i.exec(body)?.[1] ?? '', 'name')
    const from = anchorCell(body, 'from')
    const to = anchorCell(body, 'to')
    units.push({
      index: units.length + 1,
      label: `绘图对象：${name ?? position}`,
      kind: /<c:chart\b/i.test(body) ? 'chart' : /<xdr:pic\b/i.test(body) ? 'image' : 'drawing',
      locator: `${path}#anchor[${position}]`,
      text: `工作表：${sheet.name}；锚点：${from}${to ? ` → ${to}` : ''}；文字：${boundedText(normalizeText(elementTexts(body, 'a:t').join(' | ')) || '（空）', 5_000)}`,
    })
  }
}

async function addComments(
  units: OfficeInspectionUnit[], archive: OfficeArchive, sheet: WorkbookSheet, path: string,
): Promise<void> {
  const xml = await readXml(archive, path)
  for (const match of xml.matchAll(/<comment\b([^>]*)>([\s\S]*?)<\/comment>/gi)) {
    const reference = attributeValue(match[1] ?? '', 'ref') ?? '未知'
    units.push({
      index: units.length + 1,
      label: `批注：${sheet.name}!${reference}`,
      kind: 'comment',
      locator: `${path}#comment[${reference}]`,
      text: boundedText(normalizeText(elementTexts(match[2] ?? '', 't').join(' ')) || '（空）', 10_000),
    })
  }
}

function selectSheets(sheets: readonly WorkbookSheet[], name?: string): WorkbookSheet[] {
  if (!name) return [...sheets]
  const sheet = sheets.find((item) => item.name === name)
  if (!sheet) throw new OfficeProcessingError('invalid-range', `XLSX 不存在工作表：${name}`)
  return [sheet]
}

function requireRange(value?: string): CellRange | null {
  if (!value) return null
  const range = parseCellRange(value)
  if (!range) throw new OfficeProcessingError('invalid-range', `XLSX A1 范围无效：${value}`)
  return range
}

function countCollection(xml: string, collection: string, item: string): number {
  const body = new RegExp(`<${collection}\\b[^>]*>([\\s\\S]*?)<\\/${collection}>`, 'i').exec(xml)?.[1] ?? ''
  return [...body.matchAll(new RegExp(`<${item}\\b`, 'gi'))].length
}

function anchorCell(xml: string, tag: string): string {
  const body = new RegExp(`<xdr:${tag}\\b[^>]*>([\\s\\S]*?)<\\/xdr:${tag}>`, 'i').exec(xml)?.[1] ?? ''
  const column = Number(/<xdr:col\b[^>]*>(\d+)<\/xdr:col>/i.exec(body)?.[1] ?? 0) + 1
  const row = Number(/<xdr:row\b[^>]*>(\d+)<\/xdr:row>/i.exec(body)?.[1] ?? 0) + 1
  return `${columnName(column)}${row}`
}

function reindex(units: OfficeInspectionUnit[]): OfficeInspectionUnit[] {
  return units.map((unit, position) => ({ ...unit, index: position + 1 }))
}
