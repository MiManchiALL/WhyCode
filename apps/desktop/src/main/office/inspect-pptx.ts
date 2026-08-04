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
} from './relationships.ts'
import { selectViewUnits } from './inspect-common.ts'
import {
  orderedSlidePaths,
  pptxObjectUnits,
  pptxStyleUnits,
  pptxTemplateUnits,
} from './inspect-pptx-views.ts'
import { selectInspectionUnits } from './selection.ts'
import { attributeValue, elementTexts, normalizeText } from './xml.ts'

export async function inspectPptx(
  archive: OfficeArchive,
  options: OfficeInspectOptions,
): Promise<Omit<OfficeInspection, 'validation'>> {
  requirePptxOptions(options)
  const { presentation, slidePaths, slides } = await loadPptxContent(archive)
  const contentSlides = options.slideNumber
    ? slides.slice(options.slideNumber - 1, options.slideNumber)
    : slides
  if (options.slideNumber && contentSlides.length === 0) {
    throw new OfficeProcessingError('invalid-range', `PPTX 不存在幻灯片 ${options.slideNumber}`)
  }
  const selected = selectInspectionUnits(contentSlides, options.startUnit, options.unitCount)
  const notesCount = sortedEntries(archive.zip, /^ppt\/notesSlides\/notesSlide\d+\.xml$/i).length
  const externalRelationships = await countExternalRelationships(archive)
  const slideSize = presentation.match(/<p:sldSz\b([^>]*)\/?\s*>/i)?.[1]
  const width = slideSize ? attributeValue(slideSize, 'cx') : null
  const height = slideSize ? attributeValue(slideSize, 'cy') : null
  const inspection: Omit<OfficeInspection, 'validation'> = {
    format: 'pptx',
    byteLength: archive.byteLength,
    sha256: archive.sha256,
    unitKind: 'slide',
    unitCount: contentSlides.length,
    units: selected.units,
    nextUnit: selected.nextUnit,
    metadata: [
      `备注页 ${notesCount}；外部关系 ${externalRelationships}`,
      width && height ? `幻灯片尺寸 ${width}×${height} EMU` : '幻灯片尺寸未声明',
    ],
    formulaCount: 0,
    formulaErrorCount: 0,
    formulaUncalculatedCount: 0,
  }
  if (options.view === 'objects') {
    return selectViewUnits(
      inspection,
      await pptxObjectUnits(archive, slidePaths, options.slideNumber),
      options,
    )
  }
  if (options.view === 'styles') {
    return selectViewUnits(inspection, await pptxStyleUnits(archive), options)
  }
  if (options.view === 'template') {
    return selectViewUnits(
      inspection,
      await pptxTemplateUnits(archive, slidePaths, options.slideNumber),
      options,
    )
  }
  return inspection
}

async function loadPptxContent(archive: OfficeArchive) {
  const presentation = await readXml(archive, 'ppt/presentation.xml')
  const slidePaths = await orderedSlidePaths(archive, presentation)
  const slides: OfficeInspectionUnit[] = []
  for (const [position, path] of slidePaths.entries()) {
    const xml = await readXml(archive, path)
    slides.push({
      index: position + 1,
      label: `幻灯片 ${position + 1}`,
      kind: 'slide',
      locator: path,
      text: normalizeText(elementTexts(xml, 'a:t').join(' | ')),
    })
  }
  return { presentation, slidePaths, slides }
}

function requirePptxOptions(options: OfficeInspectOptions): void {
  if (options.sheetName || options.range) {
    throw new OfficeProcessingError('invalid-range', 'sheetName 和 range 只适用于 XLSX')
  }
  if (options.view === 'formula-trace') {
    throw new OfficeProcessingError('invalid-range', 'formula-trace 只适用于 XLSX')
  }
  if (options.slideNumber && !['content', 'objects', 'template'].includes(options.view)) {
    throw new OfficeProcessingError('invalid-range', 'slideNumber 只适用于 PPTX content、objects 或 template 视图')
  }
}
