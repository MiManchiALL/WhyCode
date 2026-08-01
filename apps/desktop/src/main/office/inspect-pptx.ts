import {
  OfficeProcessingError,
  type OfficeInspectOptions,
  type OfficeInspection,
  type OfficeInspectionUnit,
} from '@whycode/core/office'
import type { OfficeArchive } from './archive.ts'
import { readXml, sortedEntries } from './archive.ts'
import {
  countExternalRelationships,
  readRelationships,
  relationshipTarget,
} from './relationships.ts'
import { selectInspectionUnits } from './selection.ts'
import { attributeValue, elementTexts, normalizeText } from './xml.ts'

export async function inspectPptx(
  archive: OfficeArchive,
  options: OfficeInspectOptions,
): Promise<OfficeInspection> {
  if (options.sheetName) {
    throw new OfficeProcessingError('invalid-range', 'sheetName 只适用于 XLSX')
  }
  const presentation = await readXml(archive, 'ppt/presentation.xml')
  const relationships = await readRelationships(archive, 'ppt/_rels/presentation.xml.rels')
  const byId = new Map(relationships.filter((item) => !item.external).map((item) => [item.id, item]))
  const slidePaths: string[] = []
  for (const match of presentation.matchAll(/<p:sldId\b([^>]*)\/?\s*>/gi)) {
    const relationshipId = attributeValue(match[1] ?? '', 'r:id')
    const relationship = relationshipId ? byId.get(relationshipId) : undefined
    if (!relationship) throw new OfficeProcessingError('corrupted', 'PPTX 幻灯片顺序关系缺失')
    const path = relationshipTarget('ppt/_rels/presentation.xml.rels', relationship.target)
    if (!archive.zip.file(path)) throw new OfficeProcessingError('corrupted', `PPTX 缺少幻灯片：${path}`)
    slidePaths.push(path)
  }
  const slides: OfficeInspectionUnit[] = []
  for (const [position, path] of slidePaths.entries()) {
    const xml = await readXml(archive, path)
    const text = normalizeText(elementTexts(xml, 'a:t').join(' | '))
    slides.push({ index: position + 1, label: `幻灯片 ${position + 1}`, text })
  }
  const selected = selectInspectionUnits(slides, options.startUnit, options.unitCount)
  const notesCount = sortedEntries(archive.zip, /^ppt\/notesSlides\/notesSlide\d+\.xml$/i).length
  const externalRelationships = await countExternalRelationships(archive)
  const slideSize = presentation.match(/<p:sldSz\b([^>]*)\/?\s*>/i)?.[1]
  const width = slideSize ? attributeValue(slideSize, 'cx') : null
  const height = slideSize ? attributeValue(slideSize, 'cy') : null
  return {
    format: 'pptx',
    byteLength: archive.byteLength,
    sha256: archive.sha256,
    unitKind: 'slide',
    unitCount: slides.length,
    units: selected.units,
    nextUnit: selected.nextUnit,
    metadata: [
      `备注页 ${notesCount}；外部关系 ${externalRelationships}`,
      width && height ? `幻灯片尺寸 ${width}×${height} EMU` : '幻灯片尺寸未声明',
    ],
    formulaCount: 0,
    formulaErrorCount: 0,
  }
}
