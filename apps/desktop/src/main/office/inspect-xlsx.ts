import {
  OfficeProcessingError,
  type OfficeInspectOptions,
  type OfficeInspection,
  type OfficeInspectionUnit,
} from '@whycode/core/office'
import type { OfficeArchive } from './archive.ts'
import { readXml } from './archive.ts'
import {
  countExternalRelationships,
  readRelationships,
  relationshipTarget,
} from './relationships.ts'
import { selectInspectionUnits } from './selection.ts'
import {
  attributeValue,
  boundedText,
  decodeXmlText,
  elementTexts,
  normalizeText,
} from './xml.ts'

interface WorkbookSheet {
  name: string
  path: string
  hidden: boolean
}

interface WorksheetRow {
  physicalRow: number
  text: string
}

interface WorksheetSummary {
  rows: WorksheetRow[]
  nonemptyCells: number
  formulaCount: number
  formulaErrorCount: number
  dimension: string | null
}

const FORMULA_ERROR = /^(?:#REF!|#DIV\/0!|#VALUE!|#N\/A|#NAME\?|#NUM!|#NULL!)$/i

export async function inspectXlsx(
  archive: OfficeArchive,
  options: OfficeInspectOptions,
): Promise<OfficeInspection> {
  const workbookXml = await readXml(archive, 'xl/workbook.xml')
  const relationships = await readRelationships(archive, 'xl/_rels/workbook.xml.rels')
  const byId = new Map(relationships.filter((item) => !item.external).map((item) => [item.id, item]))
  const sheets = workbookSheets(archive, workbookXml, byId)
  const sharedStrings = await loadSharedStrings(archive)
  const summaries = new Map<string, WorksheetSummary>()
  let formulaCount = 0
  let formulaErrorCount = 0
  for (const sheet of sheets) {
    const summary = parseWorksheet(await readXml(archive, sheet.path), sharedStrings)
    summaries.set(sheet.name, summary)
    formulaCount += summary.formulaCount
    formulaErrorCount += summary.formulaErrorCount
  }

  const selectedSheet = options.sheetName
    ? sheets.find((sheet) => sheet.name === options.sheetName)
    : undefined
  if (options.sheetName && !selectedSheet) {
    throw new OfficeProcessingError('invalid-range', `XLSX 不存在工作表：${options.sheetName}`)
  }
  const sourceUnits = selectedSheet
    ? rowUnits(summaries.get(selectedSheet.name)!)
    : sheetUnits(sheets, summaries)
  const selected = selectInspectionUnits(sourceUnits, options.startUnit, options.unitCount)
  const externalRelationships = await countExternalRelationships(archive)
  const names = boundedText(sheets.map((sheet) => sheet.name).join('、'), 800)
  return {
    format: 'xlsx',
    byteLength: archive.byteLength,
    sha256: archive.sha256,
    unitKind: selectedSheet ? 'row' : 'sheet',
    unitCount: sourceUnits.length,
    units: selected.units,
    nextUnit: selected.nextUnit,
    metadata: [
      `工作表 ${sheets.length}（隐藏 ${sheets.filter((sheet) => sheet.hidden).length}）：${names || '无'}`,
      `共享字符串 ${sharedStrings.length}；外部关系 ${externalRelationships}`,
      ...(selectedSheet ? [`当前工作表：${selectedSheet.name}`] : []),
    ],
    formulaCount,
    formulaErrorCount,
  }
}

function workbookSheets(
  archive: OfficeArchive,
  workbookXml: string,
  relationships: ReadonlyMap<string, { target: string }>,
): WorkbookSheet[] {
  const sheets: WorkbookSheet[] = []
  for (const match of workbookXml.matchAll(/<sheet\b([^>]*)\/?\s*>/gi)) {
    const attributes = match[1] ?? ''
    const name = attributeValue(attributes, 'name')
    const relationshipId = attributeValue(attributes, 'r:id')
    const relationship = relationshipId ? relationships.get(relationshipId) : undefined
    if (!name || !relationship) throw new OfficeProcessingError('corrupted', 'XLSX 工作表关系缺失')
    const path = relationshipTarget('xl/_rels/workbook.xml.rels', relationship.target)
    if (!archive.zip.file(path)) throw new OfficeProcessingError('corrupted', `XLSX 缺少工作表：${path}`)
    sheets.push({
      name,
      path,
      hidden: isHiddenSheet(attributeValue(attributes, 'state')),
    })
  }
  if (sheets.length === 0) throw new OfficeProcessingError('corrupted', 'XLSX 没有工作表')
  return sheets
}

async function loadSharedStrings(archive: OfficeArchive): Promise<string[]> {
  if (!archive.zip.file('xl/sharedStrings.xml')) return []
  const xml = await readXml(archive, 'xl/sharedStrings.xml')
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)].map((match) =>
    normalizeText(elementTexts(match[1] ?? '', 't').join('')))
}

function parseWorksheet(xml: string, sharedStrings: readonly string[]): WorksheetSummary {
  const rows: WorksheetRow[] = []
  let nonemptyCells = 0
  let formulaCount = 0
  let formulaErrorCount = 0
  for (const [position, rowMatch] of [...xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/gi)].entries()) {
    const physicalRow = Number(attributeValue(rowMatch[1] ?? '', 'r')) || position + 1
    const cells: string[] = []
    for (const cellMatch of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
      const attributes = cellMatch[1] ?? ''
      const body = cellMatch[2] ?? ''
      const reference = attributeValue(attributes, 'r') ?? `R${physicalRow}C${cells.length + 1}`
      const type = attributeValue(attributes, 't')?.toLowerCase() ?? ''
      const hasFormula = /<f(?:\s|>|\/)/i.test(body)
      const formula = firstElement(body, 'f')
      const rawValue = firstElement(body, 'v')
      const value = cellValue(type, rawValue, body, sharedStrings)
      if (!hasFormula && !value) continue
      nonemptyCells++
      if (hasFormula) formulaCount++
      if (type === 'e' || FORMULA_ERROR.test(value)) formulaErrorCount++
      const rendered = hasFormula
        ? `${reference}=FORMULA(${formula || '共享公式'})${value ? ` => ${value}` : ''}`
        : `${reference}=${value}`
      cells.push(rendered)
    }
    if (cells.length > 0) rows.push({ physicalRow, text: boundedText(cells.join(' | '), 20_000) })
  }
  const dimension = /<dimension\b([^>]*)\/?\s*>/i.exec(xml)?.[1]
  return {
    rows,
    nonemptyCells,
    formulaCount,
    formulaErrorCount,
    dimension: dimension ? attributeValue(dimension, 'ref') : null,
  }
}

function isHiddenSheet(state: string | null): boolean {
  return state !== null && state.toLowerCase() !== 'visible'
}

function sheetUnits(
  sheets: readonly WorkbookSheet[],
  summaries: ReadonlyMap<string, WorksheetSummary>,
): OfficeInspectionUnit[] {
  return sheets.map((sheet, position) => {
    const summary = summaries.get(sheet.name)!
    const preview = summary.rows.slice(0, 8)
      .map((row) => `第 ${row.physicalRow} 行：${row.text}`)
      .join('\n')
    return {
      index: position + 1,
      label: `工作表 ${position + 1}：${sheet.name}${sheet.hidden ? '（隐藏）' : ''}`,
      text: [
        `使用区域 ${summary.dimension ?? '未声明'}；非空单元格 ${summary.nonemptyCells}；公式 ${summary.formulaCount}；错误值 ${summary.formulaErrorCount}`,
        preview || '（没有非空行）',
      ].join('\n'),
    }
  })
}

function rowUnits(summary: WorksheetSummary): OfficeInspectionUnit[] {
  return summary.rows.map((row, position) => ({
    index: position + 1,
    label: `第 ${row.physicalRow} 行`,
    text: row.text,
  }))
}

function firstElement(xml: string, name: string): string {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i').exec(xml)
  return match ? normalizeText(decodeXmlText(match[1] ?? '')) : ''
}

function cellValue(
  type: string,
  rawValue: string,
  body: string,
  sharedStrings: readonly string[],
): string {
  if (type === 's') {
    const index = Number(rawValue)
    return Number.isSafeInteger(index) && index >= 0
      ? sharedStrings[index] ?? `[无效共享字符串 ${rawValue}]`
      : `[无效共享字符串 ${rawValue}]`
  }
  if (type === 'inlinestr') return normalizeText(elementTexts(body, 't').join(''))
  if (type === 'b') return rawValue === '1' ? 'TRUE' : 'FALSE'
  return rawValue
}
