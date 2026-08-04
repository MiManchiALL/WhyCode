import {
  OfficeProcessingError,
  type OfficeInspectionUnit,
} from '@whycode/core/office'
import {
  type WorkbookSheet,
  type WorkbookDefinedName,
  type WorksheetCell,
  type WorksheetSummary,
} from './xlsx-package.ts'
import { columnName, parseCellRange } from './xlsx-references.ts'

interface FormulaNode {
  sheet: WorkbookSheet
  cell: WorksheetCell
}

export function xlsxFormulaTraceUnits(options: {
  sheets: readonly WorkbookSheet[]
  summaries: ReadonlyMap<string, WorksheetSummary>
  sheetName?: string
  range?: string
  definedNames: readonly WorkbookDefinedName[]
}): OfficeInspectionUnit[] {
  if (!options.sheetName || !options.range) {
    throw new OfficeProcessingError('invalid-range', 'formula-trace 需要 sheetName 和单个单元格 range')
  }
  const selectedSheet = options.sheets.find((sheet) => sheet.name === options.sheetName)
  if (!selectedSheet) {
    throw new OfficeProcessingError('invalid-range', `XLSX 不存在工作表：${options.sheetName}`)
  }
  const range = parseCellRange(options.range)
  if (!range || range.startRow !== range.endRow || range.startColumn !== range.endColumn) {
    throw new OfficeProcessingError('invalid-range', 'formula-trace 的 range 必须是单个 A1 单元格')
  }
  const targetReference = `${columnName(range.startColumn)}${range.startRow}`
  const nodes = formulaNodeMap(options.sheets, options.summaries)
  const target = nodes.get(nodeKey(selectedSheet.name, targetReference))
  if (!target) {
    throw new OfficeProcessingError('invalid-range', `${selectedSheet.name}!${targetReference} 是空单元格`)
  }
  const queue: FormulaNode[] = [target]
  const visited = new Set<string>()
  const units: OfficeInspectionUnit[] = []
  while (queue.length > 0 && units.length < 200) {
    const node = queue.shift()!
    const key = nodeKey(node.sheet.name, node.cell.reference)
    if (visited.has(key)) continue
    visited.add(key)
    const references = node.cell.hasFormula
      ? formulaReferences(
        node.cell.formula,
        node.sheet.name,
        options.sheets,
        options.definedNames,
      )
      : []
    const dependencies = references.map((reference) => nodes.get(reference)).filter(isFormulaNode)
    units.push({
      index: units.length + 1,
      label: `${node.sheet.name}!${node.cell.reference}`,
      kind: node.cell.hasFormula ? 'formula' : 'formula-input',
      locator: `${node.sheet.path}#cell[${node.cell.reference}]`,
      text: [
        node.cell.hasFormula ? `公式：${node.cell.formula || '共享公式'}` : '公式：无（输入值）',
        `已保存值：${node.cell.value || '无'}`,
        `直接依赖：${references.length > 0 ? references.join('、') : '无'}`,
      ].join('\n'),
    })
    queue.push(...dependencies)
  }
  return units
}

function formulaNodeMap(
  sheets: readonly WorkbookSheet[],
  summaries: ReadonlyMap<string, WorksheetSummary>,
): Map<string, FormulaNode> {
  const nodes = new Map<string, FormulaNode>()
  for (const sheet of sheets) {
    for (const cell of summaries.get(sheet.name)!.cells) {
      nodes.set(nodeKey(sheet.name, cell.reference), { sheet, cell })
    }
  }
  return nodes
}

function formulaReferences(
  formula: string,
  currentSheet: string,
  sheets: readonly WorkbookSheet[],
  definedNames: readonly WorkbookDefinedName[],
  depth = 0,
  seenNames = new Set<string>(),
): string[] {
  const knownSheets = new Map(sheets.map((sheet) => [sheet.name.toLowerCase(), sheet.name]))
  const source = formula.replace(/"(?:[^"]|"")*"/g, '')
  const references = new Set<string>()
  const expression = /(?<![A-Za-z0-9_.])(?:(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_.]*))!)?(\$?[A-Z]{1,3}\$?[1-9]\d*)(?::(\$?[A-Z]{1,3}\$?[1-9]\d*))?/gi
  for (const match of source.matchAll(expression)) {
    if (source[(match.index ?? 0) + match[0].length] === '(') continue
    const requestedSheet = match[1]?.replaceAll("''", "'") ?? match[2] ?? currentSheet
    const sheet = knownSheets.get(requestedSheet.toLowerCase())
    if (!sheet) continue
    const range = parseCellRange(`${match[3]}${match[4] ? `:${match[4]}` : ''}`)
    if (!range) continue
    for (let row = range.startRow; row <= range.endRow && references.size < 200; row++) {
      for (let column = range.startColumn; column <= range.endColumn && references.size < 200; column++) {
        references.add(nodeKey(sheet, `${columnName(column)}${row}`))
      }
    }
  }
  if (depth < 5) {
    const localNames = new Set(definedNames
      .filter((name) => name.localSheetName === currentSheet)
      .map((name) => name.name.toLowerCase()))
    const applicable = definedNames
      .filter((name) => name.localSheetName === currentSheet
        || (name.localSheetName === null && !localNames.has(name.name.toLowerCase())))
      .sort((left, right) => Number(right.localSheetName !== null) - Number(left.localSheetName !== null))
    for (const name of applicable) {
      const key = `${name.localSheetName ?? '*'}!${name.name}`.toLowerCase()
      if (seenNames.has(key) || !containsName(source, name.name)) continue
      const nextSeen = new Set(seenNames).add(key)
      for (const reference of formulaReferences(
        name.expression.replace(/^=/, ''),
        name.localSheetName ?? currentSheet,
        sheets,
        definedNames,
        depth + 1,
        nextSeen,
      )) references.add(reference)
    }
  }
  return [...references]
}

function containsName(formula: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^A-Za-z0-9_.])${escaped}(?![A-Za-z0-9_.])`, 'i').test(formula)
}

function nodeKey(sheet: string, reference: string): string {
  return `${sheet}!${reference.replaceAll('$', '').toUpperCase()}`
}

function isFormulaNode(value: FormulaNode | undefined): value is FormulaNode {
  return value !== undefined
}
