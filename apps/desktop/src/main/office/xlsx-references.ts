import { attributeValue, decodeXmlText, normalizeText } from './xml.ts'

export interface CellRange {
  startRow: number
  endRow: number
  startColumn: number
  endColumn: number
}

interface CellPosition {
  row: number
  column: number
}

interface SharedFormula {
  formula: string
  row: number
  column: number
}

const CELL_REFERENCE = /^\$?([A-Z]{1,3})\$?([1-9]\d*)$/i

export function resolveFormula(
  body: string,
  reference: CellPosition | null,
  shared: Map<string, SharedFormula>,
): string {
  const match = /<f\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/f>)/i.exec(body)
  if (!match) return ''
  const attributes = match[1] ?? ''
  const formula = normalizeText(decodeXmlText(match[2] ?? ''))
  const sharedIndex = attributeValue(attributes, 'si')
  if (sharedIndex && formula && reference) {
    shared.set(sharedIndex, { formula, row: reference.row, column: reference.column })
    return formula
  }
  if (sharedIndex && reference) {
    const master = shared.get(sharedIndex)
    if (master) {
      return translateFormula(
        master.formula,
        reference.row - master.row,
        reference.column - master.column,
      )
    }
  }
  return formula
}

export function parseCellRange(value: string): CellRange | null {
  const [startValue, endValue = startValue] = value.split(':')
  if (!startValue || !endValue) return null
  const start = parseCellReference(startValue)
  const end = parseCellReference(endValue)
  if (!start || !end) return null
  return {
    startRow: Math.min(start.row, end.row),
    endRow: Math.max(start.row, end.row),
    startColumn: Math.min(start.column, end.column),
    endColumn: Math.max(start.column, end.column),
  }
}

export function parseCellReference(value: string): CellPosition | null {
  const match = CELL_REFERENCE.exec(value)
  if (!match) return null
  return { row: Number(match[2]), column: columnNumber(match[1]!) }
}

export function cellInRange(cell: CellPosition, range: CellRange): boolean {
  return cell.row >= range.startRow && cell.row <= range.endRow
    && cell.column >= range.startColumn && cell.column <= range.endColumn
}

export function columnName(column: number): string {
  let value = column
  let result = ''
  while (value > 0) {
    value--
    result = String.fromCharCode(65 + (value % 26)) + result
    value = Math.floor(value / 26)
  }
  return result
}

function translateFormula(formula: string, rowDelta: number, columnDelta: number): string {
  return formula.split(/("(?:[^"]|"")*"|'(?:[^']|'')*')/g).map((segment, index) => {
    // Quoted strings and quoted sheet names can contain A1-like text but are not references.
    if (index % 2 === 1) return segment
    return segment.replace(
      /(^|[^A-Za-z0-9_.])([$]?)([A-Z]{1,3})([$]?)([1-9]\d*)/gi,
      (full, prefix: string, absoluteColumn: string, column: string,
        absoluteRow: string, row: string, offset: number, source: string) => {
        // Functions such as LOG10 look like cell references but are followed by `(`.
        if (source[offset + full.length] === '(') return full
        const nextColumn = columnNumber(column) + (absoluteColumn ? 0 : columnDelta)
        const nextRow = Number(row) + (absoluteRow ? 0 : rowDelta)
        if (nextColumn < 1 || nextRow < 1) return `${prefix}#REF!`
        return `${prefix}${absoluteColumn}${columnName(nextColumn)}${absoluteRow}${nextRow}`
      },
    )
  }).join('')
}

function columnNumber(value: string): number {
  let result = 0
  for (const character of value.toUpperCase()) {
    result = result * 26 + character.charCodeAt(0) - 64
  }
  return result
}
