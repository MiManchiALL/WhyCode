import {
  OfficeProcessingError,
  type OfficeInspectOptions,
  type OfficeInspection,
  type OfficeInspectionUnit,
} from '@whycode/core/office'
import type { OfficeArchive } from './archive.ts'
import { readXml } from './archive.ts'
import { selectViewUnits } from './inspect-common.ts'
import {
  xlsxObjectUnits,
  xlsxStyleUnits,
} from './inspect-xlsx-views.ts'
import { xlsxFormulaTraceUnits } from './inspect-xlsx-formulas.ts'
import { countExternalRelationships } from './relationships.ts'
import { selectInspectionUnits } from './selection.ts'
import { boundedText } from './xml.ts'
import {
  loadSharedStrings,
  loadDefinedNames,
  loadWorkbookSheets,
  parseWorksheet,
  type WorkbookDefinedName,
  type WorkbookSheet,
  type WorksheetSummary,
} from './xlsx-package.ts'
import {
  cellInRange,
  parseCellRange,
  type CellRange,
} from './xlsx-references.ts'

const MAX_WORKBOOK_CELLS = 200_000

interface XlsxInspectionState {
  sheets: readonly WorkbookSheet[]
  sharedStrings: readonly string[]
  definedNames: readonly WorkbookDefinedName[]
  summaries: ReadonlyMap<string, WorksheetSummary>
  formulaCount: number
  formulaErrorCount: number
  formulaUncalculatedCount: number
}

interface XlsxInspectionTarget {
  selectedSheet?: WorkbookSheet
  range: CellRange | null
}

export async function inspectXlsx(
  archive: OfficeArchive,
  options: OfficeInspectOptions,
): Promise<Omit<OfficeInspection, 'validation'>> {
  requireXlsxOptions(options)
  const state = await loadXlsxInspectionState(archive)
  const target = selectXlsxTarget(state.sheets, options)
  const sourceUnits = target.selectedSheet
    ? rowUnits(target.selectedSheet, state.summaries.get(target.selectedSheet.name)!, target.range)
    : sheetUnits(state.sheets, state.summaries)
  const inspection = await createXlsxContentInspection(archive, options, state, target, sourceUnits)
  return selectXlsxView(archive, options, state, inspection)
}

async function loadXlsxInspectionState(archive: OfficeArchive): Promise<XlsxInspectionState> {
  const sheets = await loadWorkbookSheets(archive)
  const sharedStrings = await loadSharedStrings(archive)
  const definedNames = await loadDefinedNames(archive, sheets)
  const summaries = new Map<string, WorksheetSummary>()
  let formulaCount = 0
  let formulaErrorCount = 0
  let formulaUncalculatedCount = 0
  let nonemptyCells = 0
  for (const sheet of sheets) {
    const summary = parseWorksheet(await readXml(archive, sheet.path), sharedStrings)
    nonemptyCells += summary.nonemptyCells
    if (nonemptyCells > MAX_WORKBOOK_CELLS) {
      throw new OfficeProcessingError('too-large', `XLSX 非空单元格总数超过 ${MAX_WORKBOOK_CELLS} 个检查上限`)
    }
    summaries.set(sheet.name, summary)
    formulaCount += summary.formulaCount
    formulaErrorCount += summary.formulaErrorCount
    formulaUncalculatedCount += summary.formulaUncalculatedCount
  }
  return {
    sheets,
    sharedStrings,
    definedNames,
    summaries,
    formulaCount,
    formulaErrorCount,
    formulaUncalculatedCount,
  }
}

function selectXlsxTarget(
  sheets: readonly WorkbookSheet[],
  options: OfficeInspectOptions,
): XlsxInspectionTarget {
  const selectedSheet = options.sheetName
    ? sheets.find((sheet) => sheet.name === options.sheetName)
    : undefined
  if (options.sheetName && !selectedSheet) {
    throw new OfficeProcessingError('invalid-range', `XLSX 不存在工作表：${options.sheetName}`)
  }
  const range = options.range ? parseCellRange(options.range) : null
  if (options.range && !range) {
    throw new OfficeProcessingError('invalid-range', `XLSX A1 范围无效：${options.range}`)
  }
  return { ...(selectedSheet ? { selectedSheet } : {}), range }
}

async function createXlsxContentInspection(
  archive: OfficeArchive,
  options: OfficeInspectOptions,
  state: XlsxInspectionState,
  target: XlsxInspectionTarget,
  sourceUnits: OfficeInspectionUnit[],
): Promise<Omit<OfficeInspection, 'validation'>> {
  const selected = selectInspectionUnits(sourceUnits, options.startUnit, options.unitCount)
  const externalRelationships = await countExternalRelationships(archive)
  return {
    format: 'xlsx',
    byteLength: archive.byteLength,
    sha256: archive.sha256,
    unitKind: target.selectedSheet ? 'row' : 'sheet',
    unitCount: sourceUnits.length,
    units: selected.units,
    nextUnit: selected.nextUnit,
    metadata: [
      `工作表 ${state.sheets.length}（隐藏 ${state.sheets.filter((sheet) => sheet.hidden).length}）：${boundedText(state.sheets.map((sheet) => sheet.name).join('、'), 800) || '无'}`,
      `共享字符串 ${state.sharedStrings.length}；定义名称 ${state.definedNames.length}；外部关系 ${externalRelationships}`,
      ...(target.selectedSheet ? [`当前工作表：${target.selectedSheet.name}${options.range ? `；范围：${options.range}` : ''}`] : []),
    ],
    formulaCount: state.formulaCount,
    formulaErrorCount: state.formulaErrorCount,
    formulaUncalculatedCount: state.formulaUncalculatedCount,
  }
}

async function selectXlsxView(
  archive: OfficeArchive,
  options: OfficeInspectOptions,
  state: XlsxInspectionState,
  inspection: Omit<OfficeInspection, 'validation'>,
): Promise<Omit<OfficeInspection, 'validation'>> {
  if (options.view === 'objects') {
    return selectViewUnits(inspection, await xlsxObjectUnits({
      archive,
      sheets: state.sheets,
      summaries: state.summaries,
      sheetName: options.sheetName,
      range: options.range,
      definedNames: state.definedNames,
    }), options)
  }
  if (options.view === 'styles') {
    return selectViewUnits(inspection, await xlsxStyleUnits(archive), options)
  }
  if (options.view === 'formula-trace') {
    return selectViewUnits(inspection, xlsxFormulaTraceUnits({
      sheets: state.sheets,
      summaries: state.summaries,
      sheetName: options.sheetName,
      range: options.range,
      definedNames: state.definedNames,
    }), options)
  }
  return inspection
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
      kind: 'worksheet',
      locator: sheet.path,
      text: [
        `使用区域 ${summary.dimension ?? '未声明'}；非空单元格 ${summary.nonemptyCells}；公式 ${summary.formulaCount}；未计算 ${summary.formulaUncalculatedCount}；错误值 ${summary.formulaErrorCount}`,
        preview || '（没有非空行）',
      ].join('\n'),
    }
  })
}

function rowUnits(
  sheet: WorkbookSheet,
  summary: WorksheetSummary,
  range: CellRange | null,
): OfficeInspectionUnit[] {
  return summary.rows.flatMap((row) => {
    const cells = range ? row.cells.filter((cell) => cellInRange(cell, range)) : row.cells
    if (cells.length === 0) return []
    const text = cells.map((cell) => cell.hasFormula
      ? `${cell.reference}=FORMULA(${cell.formula || '共享公式'})${cell.value ? ` => ${cell.value}` : ''}`
      : `${cell.reference}=${cell.value}`).join(' | ')
    return [{
      index: 1,
      label: `第 ${row.physicalRow} 行`,
      kind: 'row',
      locator: `${sheet.path}#row[${row.physicalRow}]`,
      text: boundedText(text, 20_000),
    }]
  }).map((unit, position) => ({ ...unit, index: position + 1 }))
}

function requireXlsxOptions(options: OfficeInspectOptions): void {
  if (options.slideNumber) {
    throw new OfficeProcessingError('invalid-range', 'slideNumber 只适用于 PPTX')
  }
  if (options.range && !options.sheetName) {
    throw new OfficeProcessingError('invalid-range', 'XLSX 使用 range 时必须同时指定 sheetName')
  }
  if (options.view === 'template') {
    throw new OfficeProcessingError(
      'invalid-range',
      'template 视图只适用于 DOCX 和 PPTX；XLSX 模板请读取 content、objects 与 styles',
    )
  }
  if (
    (options.sheetName || options.range)
    && !['content', 'objects', 'formula-trace'].includes(options.view)
  ) {
    throw new OfficeProcessingError(
      'invalid-range',
      'sheetName 和 range 只适用于 XLSX content、objects 或 formula-trace 视图',
    )
  }
}
