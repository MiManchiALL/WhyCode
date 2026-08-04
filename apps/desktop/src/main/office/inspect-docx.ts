import type {
  OfficeInspectOptions,
  OfficeInspection,
  OfficeInspectionUnit,
} from '@whycode/core/office'
import { OfficeProcessingError } from '@whycode/core/office'
import type { OfficeArchive } from './archive.ts'
import { readXml, sortedEntries } from './archive.ts'
import { countExternalRelationships } from './relationships.ts'
import { selectInspectionUnits } from './selection.ts'
import { selectViewUnits } from './inspect-common.ts'
import { docxObjectUnits, docxStyleUnits, docxTemplateUnits } from './inspect-docx-views.ts'
import { elementTexts, normalizeText } from './xml.ts'

export async function inspectDocx(
  archive: OfficeArchive,
  options: OfficeInspectOptions,
): Promise<Omit<OfficeInspection, 'validation'>> {
  requireDocxOptions(options)
  const documentXml = await readXml(archive, 'word/document.xml')
  const blocks = documentBlocks(documentXml)
  const selected = selectInspectionUnits(blocks, options.startUnit, options.unitCount)
  const headerCount = sortedEntries(archive.zip, /^word\/header\d+\.xml$/i).length
  const footerCount = sortedEntries(archive.zip, /^word\/footer\d+\.xml$/i).length
  const sectionCount = Math.max(1, [...documentXml.matchAll(/<w:sectPr\b/gi)].length)
  const externalRelationships = await countExternalRelationships(archive)
  const inspection: Omit<OfficeInspection, 'validation'> = {
    format: 'docx',
    byteLength: archive.byteLength,
    sha256: archive.sha256,
    unitKind: 'block',
    unitCount: blocks.length,
    units: selected.units,
    nextUnit: selected.nextUnit,
    metadata: [
      `节 ${sectionCount}；页眉部件 ${headerCount}；页脚部件 ${footerCount}`,
      `外部关系 ${externalRelationships}`,
    ],
    formulaCount: 0,
    formulaErrorCount: 0,
    formulaUncalculatedCount: 0,
  }
  if (options.view === 'objects') {
    return selectViewUnits(inspection, await docxObjectUnits(archive), options)
  }
  if (options.view === 'styles') {
    return selectViewUnits(inspection, await docxStyleUnits(archive), options)
  }
  if (options.view === 'template') {
    return selectViewUnits(inspection, await docxTemplateUnits(archive), options)
  }
  return inspection
}

function requireDocxOptions(options: OfficeInspectOptions): void {
  if (options.sheetName || options.range) {
    throw new OfficeProcessingError('invalid-range', 'sheetName 和 range 只适用于 XLSX')
  }
  if (options.slideNumber) {
    throw new OfficeProcessingError('invalid-range', 'slideNumber 只适用于 PPTX')
  }
  if (options.view === 'formula-trace') {
    throw new OfficeProcessingError('invalid-range', 'formula-trace 只适用于 XLSX')
  }
}

function documentBlocks(xml: string): OfficeInspectionUnit[] {
  const blocks: OfficeInspectionUnit[] = []
  let paragraphPosition = 0
  for (const match of xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/gi)) {
    paragraphPosition++
    const paragraph = match[1] ?? ''
    const pieces = elementTexts(paragraph, 'w:t')
    const text = normalizeText(pieces.join(' '))
    if (!text) continue
    const index = blocks.length + 1
    blocks.push({
      index,
      label: `正文块 ${index}`,
      kind: 'paragraph',
      locator: `word/document.xml#paragraph[${paragraphPosition}]`,
      text,
    })
  }
  return blocks
}
