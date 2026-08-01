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
import { elementTexts, normalizeText } from './xml.ts'

export async function inspectDocx(
  archive: OfficeArchive,
  options: OfficeInspectOptions,
): Promise<OfficeInspection> {
  if (options.sheetName) throw new OfficeProcessingError('invalid-range', 'sheetName 只适用于 XLSX')
  const documentXml = await readXml(archive, 'word/document.xml')
  const blocks = documentBlocks(documentXml)
  const selected = selectInspectionUnits(blocks, options.startUnit, options.unitCount)
  const headerCount = sortedEntries(archive.zip, /^word\/header\d+\.xml$/i).length
  const footerCount = sortedEntries(archive.zip, /^word\/footer\d+\.xml$/i).length
  const sectionCount = Math.max(1, [...documentXml.matchAll(/<w:sectPr\b/gi)].length)
  const externalRelationships = await countExternalRelationships(archive)
  return {
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
  }
}

function documentBlocks(xml: string): OfficeInspectionUnit[] {
  const blocks: OfficeInspectionUnit[] = []
  for (const match of xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/gi)) {
    const paragraph = match[1] ?? ''
    const pieces = elementTexts(paragraph, 'w:t')
    const text = normalizeText(pieces.join(' '))
    if (!text) continue
    const index = blocks.length + 1
    blocks.push({ index, label: `正文块 ${index}`, text })
  }
  return blocks
}
