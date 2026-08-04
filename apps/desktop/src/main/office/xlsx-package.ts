import { OfficeProcessingError } from '@whycode/core/office'
import type { OfficeArchive } from './archive.ts'
import { readXml } from './archive.ts'
import { readRelationships, relationshipTarget } from './relationships.ts'
import { parseCellReference, resolveFormula } from './xlsx-references.ts'
import {
  attributeValue,
  boundedText,
  decodeXmlText,
  elementTexts,
  normalizeText,
} from './xml.ts'

export interface WorkbookSheet {
  name: string
  path: string
  hidden: boolean
}

export interface WorkbookDefinedName {
  name: string
  expression: string
  localSheetName: string | null
  hidden: boolean
}

export interface WorksheetCell {
  reference: string
  row: number
  column: number
  type: string
  styleIndex: number | null
  formula: string
  value: string
  hasFormula: boolean
  hasCachedValue: boolean
}

export interface WorksheetRow {
  physicalRow: number
  cells: WorksheetCell[]
  text: string
}

export interface WorksheetSummary {
  cells: WorksheetCell[]
  rows: WorksheetRow[]
  nonemptyCells: number
  formulaCount: number
  formulaErrorCount: number
  formulaUncalculatedCount: number
  dimension: string | null
}

const FORMULA_ERROR = /^(?:#REF!|#DIV\/0!|#VALUE!|#N\/A|#NAME\?|#NUM!|#NULL!|#SPILL!|#CALC!|#FIELD!|#BLOCKED!|#UNKNOWN!|#CONNECT!|#BUSY!|#GETTING_DATA)$/i
const MAX_SHARED_STRINGS = 200_000
const MAX_DEFINED_NAMES = 20_000
const MAX_WORKSHEET_CELLS = 100_000

export async function loadWorkbookSheets(archive: OfficeArchive): Promise<WorkbookSheet[]> {
  const workbookXml = await readXml(archive, 'xl/workbook.xml')
  const relationships = await readRelationships(archive, 'xl/_rels/workbook.xml.rels')
  const byId = new Map(relationships.filter((item) => !item.external).map((item) => [item.id, item]))
  const sheets: WorkbookSheet[] = []
  for (const match of workbookXml.matchAll(/<sheet\b([^>]*)\/?\s*>/gi)) {
    const attributes = match[1] ?? ''
    const name = attributeValue(attributes, 'name')
    const relationshipId = attributeValue(attributes, 'r:id')
    const relationship = relationshipId ? byId.get(relationshipId) : undefined
    if (!name || !relationship) throw new OfficeProcessingError('corrupted', 'XLSX 工作表关系缺失')
    const path = relationshipTarget('xl/_rels/workbook.xml.rels', relationship.target)
    if (!archive.zip.file(path)) throw new OfficeProcessingError('corrupted', `XLSX 缺少工作表：${path}`)
    sheets.push({
      name,
      path,
      hidden: attributeValue(attributes, 'state')?.toLowerCase() !== 'visible'
        && attributeValue(attributes, 'state') !== null,
    })
  }
  if (sheets.length === 0) throw new OfficeProcessingError('corrupted', 'XLSX 没有工作表')
  return sheets
}

export async function loadSharedStrings(archive: OfficeArchive): Promise<string[]> {
  if (!archive.zip.file('xl/sharedStrings.xml')) return []
  const xml = await readXml(archive, 'xl/sharedStrings.xml')
  const strings: string[] = []
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)) {
    if (strings.length >= MAX_SHARED_STRINGS) {
      throw new OfficeProcessingError('too-large', `XLSX 共享字符串超过 ${MAX_SHARED_STRINGS} 个检查上限`)
    }
    strings.push(normalizeText(elementTexts(match[1] ?? '', 't').join('')))
  }
  return strings
}

export async function loadDefinedNames(
  archive: OfficeArchive,
  sheets: readonly WorkbookSheet[],
): Promise<WorkbookDefinedName[]> {
  const workbook = await readXml(archive, 'xl/workbook.xml')
  const names: WorkbookDefinedName[] = []
  for (const match of workbook.matchAll(/<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/gi)) {
    if (names.length >= MAX_DEFINED_NAMES) {
      throw new OfficeProcessingError('too-large', `XLSX 定义名称超过 ${MAX_DEFINED_NAMES} 个检查上限`)
    }
    const attributes = match[1] ?? ''
    const name = attributeValue(attributes, 'name')
    if (!name) continue
    const localSheetId = attributeValue(attributes, 'localSheetId')
    const localIndex = localSheetId !== null && /^\d+$/.test(localSheetId)
      ? Number(localSheetId)
      : null
    names.push({
      name,
      expression: normalizeText(decodeXmlText(match[2] ?? '')),
      localSheetName: localIndex === null ? null : sheets[localIndex]?.name ?? null,
      hidden: attributeValue(attributes, 'hidden') === '1',
    })
  }
  return names
}

export function parseWorksheet(
  xml: string,
  sharedStrings: readonly string[],
): WorksheetSummary {
  const sharedFormulas = new Map<string, { formula: string; row: number; column: number }>()
  const cells: WorksheetCell[] = []
  const rows: WorksheetRow[] = []
  let formulaErrorCount = 0
  let formulaUncalculatedCount = 0
  let rowPosition = 0
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/gi)) {
    const physicalRow = Number(attributeValue(rowMatch[1] ?? '', 'r')) || rowPosition + 1
    rowPosition++
    const rowCells: WorksheetCell[] = []
    for (const cellMatch of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
      const attributes = cellMatch[1] ?? ''
      const body = cellMatch[2] ?? ''
      const reference = attributeValue(attributes, 'r') ?? `A${physicalRow}`
      const parsedReference = parseCellReference(reference)
      const type = attributeValue(attributes, 't')?.toLowerCase() ?? ''
      const style = attributeValue(attributes, 's')
      const hasFormula = /<f(?:\s|>|\/)/i.test(body)
      const formula = hasFormula
        ? resolveFormula(body, parsedReference, sharedFormulas)
        : ''
      const rawValue = firstElement(body, 'v')
      const hasCachedValue = /<v(?:\s[^>]*)?>[\s\S]*?<\/v>/i.test(body)
      const value = cellValue(type, rawValue, body, sharedStrings)
      if (!hasFormula && !value) continue
      if (cells.length >= MAX_WORKSHEET_CELLS) {
        throw new OfficeProcessingError('too-large', `XLSX 单个工作表非空单元格超过 ${MAX_WORKSHEET_CELLS} 个检查上限`)
      }
      const cell: WorksheetCell = {
        reference,
        row: parsedReference?.row ?? physicalRow,
        column: parsedReference?.column ?? rowCells.length + 1,
        type,
        styleIndex: style !== null && /^\d+$/.test(style) ? Number(style) : null,
        formula,
        value,
        hasFormula,
        hasCachedValue,
      }
      if (hasFormula && !hasCachedValue) formulaUncalculatedCount++
      if (type === 'e' || FORMULA_ERROR.test(value)) formulaErrorCount++
      cells.push(cell)
      rowCells.push(cell)
    }
    if (rowCells.length > 0) {
      rows.push({
        physicalRow,
        cells: rowCells,
        text: boundedText(rowCells.map(renderCell).join(' | '), 20_000),
      })
    }
  }
  const dimension = /<dimension\b([^>]*)\/?\s*>/i.exec(xml)?.[1]
  return {
    cells,
    rows,
    nonemptyCells: cells.length,
    formulaCount: cells.filter((cell) => cell.hasFormula).length,
    formulaErrorCount,
    formulaUncalculatedCount,
    dimension: dimension ? attributeValue(dimension, 'ref') : null,
  }
}

function renderCell(cell: WorksheetCell): string {
  return cell.hasFormula
    ? `${cell.reference}=FORMULA(${cell.formula || '共享公式'})${cell.value ? ` => ${cell.value}` : ''}`
    : `${cell.reference}=${cell.value}`
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
