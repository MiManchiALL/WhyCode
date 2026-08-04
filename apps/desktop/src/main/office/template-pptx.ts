import JSZip from 'jszip'
import { OfficeProcessingError } from '@whycode/core/office'
import {
  applySlideEdits,
  imageRelationshipId,
  replaceImageRelationshipId,
  updateSlideNumberFields,
} from './template-pptx-edits.ts'
import {
  pptxRelationshipIds,
  pptxRelationshipReferenceCount,
} from './pptx-shapes.ts'
import {
  IMAGE_CONTENT_TYPES,
  hasImage,
  parsePptxTemplatePlan,
} from './template-pptx-plan.ts'
import {
  addDefault,
  addOverride,
  appendRelationship,
  emptyRelationships,
  maxPartNumber,
  maxRelationshipNumber,
  nextRelationshipId,
  orderedSlides,
  parseRelationships,
  relationshipPath,
  relativeTarget,
  resolveRelationshipTarget,
  replaceRelationshipTarget,
  replaceRelationshipTargetById,
  removeRelationshipsById,
  requiredText,
  uniqueMediaPath,
  xmlAttribute,
} from './template-pptx-package.ts'

const PRESENTATION_RELS_PATH = 'ppt/_rels/presentation.xml.rels'

export async function createPptxFromTemplate(value: unknown): Promise<Uint8Array> {
  const plan = parsePptxTemplatePlan(value)
  const zip = await JSZip.loadAsync(plan.template)
  let presentation = await requiredText(zip, 'ppt/presentation.xml')
  let presentationRels = await requiredText(zip, PRESENTATION_RELS_PATH)
  let contentTypes = await requiredText(zip, '[Content_Types].xml')
  const relationships = parseRelationships(presentationRels)
  const sourceSlides = orderedSlides(presentation, relationships, PRESENTATION_RELS_PATH)
  let slideNumber = maxPartNumber(zip, /^ppt\/slides\/slide(\d+)\.xml$/i)
  let notesNumber = maxPartNumber(zip, /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/i)
  let relationshipNumber = maxRelationshipNumber(relationships)
  let slideId = maximumSlideId(presentation)
  const firstSlideNumber = presentationFirstSlideNumber(presentation)
  const slideEntries: string[] = []

  for (const item of plan.slides) {
    const sourcePath = sourceSlides[item.sourceSlide - 1]
    if (!sourcePath) {
      throw new OfficeProcessingError('invalid-range', `PPTX 模板不存在幻灯片 ${item.sourceSlide}`)
    }
    const newSlidePath = `ppt/slides/slide${++slideNumber}.xml`
    const sourceXml = await requiredText(zip, sourcePath)
    const applied = applySlideEdits(sourceXml, item.edits)
    let slideXml = updateSlideNumberFields(
      applied.xml,
      firstSlideNumber + slideEntries.length,
    )

    const sourceRelsPath = relationshipPath(sourcePath)
    let slideRels = zip.file(sourceRelsPath)
      ? await requiredText(zip, sourceRelsPath)
      : emptyRelationships()
    const mediaResult = replaceSlideMedia({
      zip,
      sourceXml,
      slideXml,
      slideRels,
      newSlidePath,
      slideNumber,
      edits: item.edits,
      contentTypes,
    })
    slideXml = mediaResult.slideXml
    slideRels = mediaResult.slideRels
    contentTypes = mediaResult.contentTypes
    const referencedRelationships = pptxRelationshipIds(slideXml)
    const removedRelationships = new Set(
      [...applied.removedRelationshipIds].filter((id) => !referencedRelationships.has(id)),
    )
    slideRels = removeRelationshipsById(slideRels, removedRelationships)

    const notesResult = await cloneSlideNotes({
      zip,
      sourceRelsPath,
      slideRels,
      newSlidePath,
      notesNumber,
      contentTypes,
    })
    notesNumber = notesResult.notesNumber
    slideRels = notesResult.slideRels
    contentTypes = notesResult.contentTypes
    zip.file(newSlidePath, slideXml)
    zip.file(relationshipPath(newSlidePath), slideRels)
    contentTypes = addOverride(
      contentTypes,
      `/${newSlidePath}`,
      'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
    )

    const relationshipId = nextRelationshipId(++relationshipNumber, presentationRels)
    relationshipNumber = Number(relationshipId.slice(3))
    presentationRels = appendRelationship(presentationRels, {
      id: relationshipId,
      type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
      target: relativeTarget('ppt/presentation.xml', newSlidePath),
    })
    slideEntries.push(`<p:sldId id="${++slideId}" r:id="${relationshipId}"/>`)
  }

  presentation = replaceSlideOrder(presentation, slideEntries)
  zip.file('ppt/presentation.xml', presentation)
  zip.file(PRESENTATION_RELS_PATH, presentationRels)
  zip.file('[Content_Types].xml', contentTypes)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

function replaceSlideMedia(options: {
  zip: JSZip
  sourceXml: string
  slideXml: string
  slideRels: string
  newSlidePath: string
  slideNumber: number
  edits: ReturnType<typeof parsePptxTemplatePlan>['slides'][number]['edits']
  contentTypes: string
}): { slideXml: string; slideRels: string; contentTypes: string } {
  let { slideXml, slideRels, contentTypes } = options
  let relationshipNumber = maxRelationshipNumber(parseRelationships(slideRels))
  for (const [position, edit] of options.edits.filter(hasImage).entries()) {
    const relationshipId = imageRelationshipId(options.sourceXml, edit.shapeId)
    const relationship = parseRelationships(slideRels).find((entry) =>
      entry.id === relationshipId && entry.type.endsWith('/image'))
    if (!relationship) {
      throw new OfficeProcessingError(
        'corrupted',
        `PPTX 模板图片 shape[${edit.shapeId}] 缺少内部图片关系`,
      )
    }
    const mediaPath = uniqueMediaPath(
      options.zip,
      options.slideNumber,
      position + 1,
      edit.image.extension,
    )
    options.zip.file(mediaPath, edit.image.bytes)
    const target = relativeTarget(options.newSlidePath, mediaPath)
    if (pptxRelationshipReferenceCount(slideXml, relationshipId) > 1) {
      const newRelationshipId = nextRelationshipId(++relationshipNumber, slideRels)
      relationshipNumber = Number(newRelationshipId.slice(3))
      slideRels = appendRelationship(slideRels, {
        id: newRelationshipId,
        target,
        type: relationship.type,
      })
      slideXml = replaceImageRelationshipId(slideXml, edit.shapeId, newRelationshipId)
    } else {
      slideRels = replaceRelationshipTargetById(slideRels, relationshipId, target)
    }
    contentTypes = addDefault(
      contentTypes,
      edit.image.extension,
      IMAGE_CONTENT_TYPES[edit.image.extension],
    )
  }
  return { slideXml, slideRels, contentTypes }
}

async function cloneSlideNotes(options: {
  zip: JSZip
  sourceRelsPath: string
  slideRels: string
  newSlidePath: string
  notesNumber: number
  contentTypes: string
}): Promise<{ slideRels: string; notesNumber: number; contentTypes: string }> {
  const notes = parseRelationships(options.slideRels)
    .find((entry) => entry.type.endsWith('/notesSlide'))
  if (!notes) return options
  const sourceNotesPath = resolveRelationshipTarget(options.sourceRelsPath, notes.target)
  const notesNumber = options.notesNumber + 1
  const newNotesPath = `ppt/notesSlides/notesSlide${notesNumber}.xml`
  options.zip.file(newNotesPath, await requiredText(options.zip, sourceNotesPath))
  const sourceNotesRelsPath = relationshipPath(sourceNotesPath)
  if (options.zip.file(sourceNotesRelsPath)) {
    const notesRels = await requiredText(options.zip, sourceNotesRelsPath)
    options.zip.file(
      relationshipPath(newNotesPath),
      replaceRelationshipTarget(
        notesRels,
        '/slide',
        relativeTarget(newNotesPath, options.newSlidePath),
      ),
    )
  }
  return {
    notesNumber,
    slideRels: replaceRelationshipTarget(
      options.slideRels,
      '/notesSlide',
      relativeTarget(options.newSlidePath, newNotesPath),
    ),
    contentTypes: addOverride(
      options.contentTypes,
      `/${newNotesPath}`,
      'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml',
    ),
  }
}

function replaceSlideOrder(presentation: string, entries: readonly string[]): string {
  const output = presentation.replace(
    /(<p:sldIdLst\b[^>]*>)[\s\S]*?(<\/p:sldIdLst>)/i,
    `$1${entries.join('')}$2`,
  )
  if (output === presentation) {
    throw new OfficeProcessingError('corrupted', 'PPTX 模板缺少可更新的幻灯片顺序表')
  }
  return output
}

function maximumSlideId(presentation: string): number {
  return Math.max(255, ...[...presentation.matchAll(/<p:sldId\b([^>]*)/gi)]
    .map((match) => Number(xmlAttribute(match[1] ?? '', 'id')) || 0))
}

function presentationFirstSlideNumber(presentation: string): number {
  const attributes = /<p:presentation\b([^>]*)/i.exec(presentation)?.[1] ?? ''
  return Number(xmlAttribute(attributes, 'firstSlideNum')) || 1
}
