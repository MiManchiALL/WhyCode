import { readXml, sortedEntries } from './archive.ts'
import type { ValidationState } from './validation-state.ts'
import { validationIssue } from './validation-state.ts'
import { attributeValue } from './xml.ts'
import {
  loadSharedStrings,
  loadWorkbookSheets,
  parseWorksheet,
  type WorksheetCell,
} from './xlsx-package.ts'

export async function validateXlsxPackage(state: ValidationState): Promise<void> {
  const workbook = await readXml(state.archive, 'xl/workbook.xml')
  const externalLinks = sortedEntries(state.archive.zip, /^xl\/externalLinks\/externalLink\d+\.xml$/i)
  if (externalLinks.length > 0) {
    validationIssue(
      state,
      'xlsx-external-workbook',
      'warning',
      externalLinks[0]!.name,
      `工作簿包含 ${externalLinks.length} 个外部工作簿链接，禁用链接更新时不能证明其公式数据已刷新`,
    )
  }
  validateWorksheetNames(state, workbook)
  validatePrintAreas(state, workbook)
  const styleInfo = await loadStyleInfo(state)
  const sharedStrings = await loadSharedStrings(state.archive)
  for (const sheet of await loadWorkbookSheets(state.archive)) {
    const xml = await readXml(state.archive, sheet.path)
    validateCells(state, xml, sheet.path, styleInfo.count)
    validateWorksheetRanges(state, xml, sheet.path)
    validateCellClipping(state, xml, sheet.path, sharedStrings, styleInfo.wrapped)
  }
  await validateTables(state)
  await validateDrawingAnchors(state)
}

function validateWorksheetNames(state: ValidationState, workbook: string): void {
  const names = new Set<string>()
  const sheetIds = new Set<string>()
  for (const match of workbook.matchAll(/<sheet\b([^>]*)\/?\s*>/gi)) {
    const attributes = match[1] ?? ''
    const name = attributeValue(attributes, 'name') ?? ''
    const normalized = name.toLowerCase()
    if (!name || name.length > 31 || /[\\/?*\[\]:]/.test(name)) {
      validationIssue(state, 'worksheet-name', 'error', 'xl/workbook.xml', `工作表名称无效：${name || '(empty)'}`)
    }
    if (names.has(normalized)) {
      validationIssue(state, 'worksheet-name-duplicate', 'error', 'xl/workbook.xml', `工作表名称重复：${name}`)
    }
    names.add(normalized)
    const sheetId = attributeValue(attributes, 'sheetId') ?? ''
    if (!sheetId || sheetIds.has(sheetId)) {
      validationIssue(state, 'worksheet-id', 'error', 'xl/workbook.xml', `工作表 ID 缺失或重复：${sheetId}`)
    }
    sheetIds.add(sheetId)
  }
}

function validatePrintAreas(state: ValidationState, workbook: string): void {
  for (const match of workbook.matchAll(/<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/gi)) {
    const name = attributeValue(match[1] ?? '', 'name')
    if (name !== '_xlnm.Print_Area') continue
    const expression = (match[2] ?? '').replace(/&apos;/gi, "'")
    const ranges = expression.split(',').map((value) => value.split('!').at(-1)?.replaceAll('$', '') ?? '')
    if (ranges.length === 0 || ranges.some((range) => !isCellRange(range))) {
      validationIssue(state, 'xlsx-print-area', 'warning', 'xl/workbook.xml', `打印区域表达式无效：${expression}`)
    }
  }
}

function validateCells(
  state: ValidationState,
  xml: string,
  location: string,
  styleCount: number,
): void {
  for (const match of xml.matchAll(/<c\b([^>]*)>/gi)) {
    const style = attributeValue(match[1] ?? '', 's')
    if (style !== null && (!/^\d+$/.test(style) || Number(style) >= styleCount)) {
      validationIssue(state, 'cell-style-index', 'error', location, `单元格样式索引越界：${style}`)
    }
  }
  if (/<f(?:\s[^>]*)?>[\s\S]*?#REF![\s\S]*?<\/f>/i.test(xml)) {
    validationIssue(state, 'formula-reference', 'error', location, '公式表达式包含 #REF!')
  }
}

function validateWorksheetRanges(state: ValidationState, xml: string, location: string): void {
  for (const match of xml.matchAll(/<(?:mergeCell|autoFilter)\b([^>]*)\/?\s*>/gi)) {
    const reference = attributeValue(match[1] ?? '', 'ref') ?? ''
    if (!isCellRange(reference)) {
      validationIssue(state, 'worksheet-range', 'error', location, `工作表范围无效：${reference || '(empty)'}`)
    }
  }
  for (const match of xml.matchAll(/<(?:conditionalFormatting|dataValidation)\b([^>]*)/gi)) {
    const references = attributeValue(match[1] ?? '', 'sqref')?.split(/\s+/).filter(Boolean) ?? []
    if (references.some((reference) => !isCellRange(reference))) {
      validationIssue(state, 'worksheet-rule-range', 'error', location, `工作表规则范围无效：${references.join(' ')}`)
    }
  }
}

function validateCellClipping(
  state: ValidationState,
  xml: string,
  location: string,
  sharedStrings: readonly string[],
  wrappedStyles: ReadonlySet<number>,
): void {
  const summary = parseWorksheet(xml, sharedStrings)
  const widths = columnWidths(xml)
  const byCoordinate = new Map(summary.cells.map((cell) => [`${cell.row}:${cell.column}`, cell]))
  const merged = [...xml.matchAll(/<mergeCell\b([^>]*)\/?\s*>/gi)]
    .map((match) => attributeValue(match[1] ?? '', 'ref') ?? '')
  let warningCount = 0
  for (const cell of summary.cells) {
    if (warningCount >= 20 || !likelyText(cell) || wrappedStyles.has(cell.styleIndex ?? 0)) continue
    if (merged.some((range) => range.toUpperCase().startsWith(`${cell.reference.toUpperCase()}:`))) continue
    const width = widths.get(cell.column) ?? 8.43
    const rightOccupied = byCoordinate.has(`${cell.row}:${cell.column + 1}`)
    if (rightOccupied && cell.value.length > Math.max(12, Math.floor(width * 1.8))) {
      warningCount++
      validationIssue(state, 'xlsx-text-clipping', 'warning', `${location}#cell[${cell.reference}]`, `文本长度 ${cell.value.length}，列宽 ${width}，右侧单元格非空且未启用自动换行`)
    }
  }
}

async function validateTables(state: ValidationState): Promise<void> {
  const names = new Set<string>()
  for (const entry of sortedEntries(state.archive.zip, /^xl\/tables\/table\d+\.xml$/i)) {
    const xml = await readXml(state.archive, entry.name)
    const attributes = /<table\b([^>]*)>/i.exec(xml)?.[1] ?? ''
    const name = attributeValue(attributes, 'displayName') ?? attributeValue(attributes, 'name') ?? ''
    const normalized = name.toLowerCase()
    if (!name || names.has(normalized)) {
      validationIssue(state, 'table-name', 'error', entry.name, `表名称缺失或重复：${name}`)
    }
    names.add(normalized)
    if (!isCellRange(attributeValue(attributes, 'ref') ?? '')) {
      validationIssue(state, 'table-range', 'error', entry.name, '表范围无效')
    }
  }
}

async function validateDrawingAnchors(state: ValidationState): Promise<void> {
  for (const entry of sortedEntries(state.archive.zip, /^xl\/drawings\/drawing\d+\.xml$/i)) {
    const xml = await readXml(state.archive, entry.name)
    let position = 0
    for (const match of xml.matchAll(/<xdr:(?:twoCellAnchor|oneCellAnchor)\b[^>]*>([\s\S]*?)<\/xdr:(?:twoCellAnchor|oneCellAnchor)>/gi)) {
      position++
      const body = match[1] ?? ''
      const columns = [...body.matchAll(/<xdr:col\b[^>]*>(\d+)<\/xdr:col>/gi)].map((item) => Number(item[1]))
      const rows = [...body.matchAll(/<xdr:row\b[^>]*>(\d+)<\/xdr:row>/gi)].map((item) => Number(item[1]))
      if (columns.some((value) => value < 0 || value >= 16_384) || rows.some((value) => value < 0 || value >= 1_048_576)) {
        validationIssue(state, 'xlsx-drawing-anchor', 'warning', `${entry.name}#anchor[${position}]`, '绘图锚点超出工作表边界')
      }
      if (columns.length > 1 && rows.length > 1 && (columns[1]! < columns[0]! || rows[1]! < rows[0]!)) {
        validationIssue(state, 'xlsx-drawing-anchor-order', 'warning', `${entry.name}#anchor[${position}]`, '绘图结束锚点位于开始锚点之前')
      }
    }
  }
}

async function loadStyleInfo(state: ValidationState): Promise<{ count: number; wrapped: Set<number> }> {
  if (!state.archive.zip.file('xl/styles.xml')) return { count: 1, wrapped: new Set() }
  const xml = await readXml(state.archive, 'xl/styles.xml')
  const body = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/i.exec(xml)?.[1] ?? ''
  const styles = [...body.matchAll(/<xf\b([^>]*)(?:\/>|>([\s\S]*?)<\/xf>)/gi)]
  const wrapped = new Set<number>()
  styles.forEach((match, index) => {
    const alignment = /<alignment\b([^>]*)\/?\s*>/i.exec(match[2] ?? '')?.[1] ?? ''
    if (attributeValue(alignment, 'wrapText') === '1') wrapped.add(index)
  })
  return { count: Math.max(1, styles.length), wrapped }
}

function columnWidths(xml: string): Map<number, number> {
  const widths = new Map<number, number>()
  for (const match of xml.matchAll(/<col\b([^>]*)\/?\s*>/gi)) {
    const attributes = match[1] ?? ''
    const minimum = Number(attributeValue(attributes, 'min'))
    const maximum = Number(attributeValue(attributes, 'max'))
    const width = Number(attributeValue(attributes, 'width'))
    if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || !Number.isFinite(width)) continue
    for (let column = minimum; column <= maximum && column - minimum < 1_000; column++) widths.set(column, width)
  }
  return widths
}

function likelyText(cell: WorksheetCell): boolean {
  return !cell.hasFormula && (cell.type === 's' || cell.type === 'inlinestr' || cell.type === 'str')
}

function isCellRange(value: string): boolean {
  return /^\$?[A-Z]{1,3}\$?[1-9]\d*(?::\$?[A-Z]{1,3}\$?[1-9]\d*)?$/i.test(value)
}
