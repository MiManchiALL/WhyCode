import { createHash } from 'node:crypto'
import {
  OfficeProcessingError,
  type OfficeTemplateComparison,
  type OfficeFormat,
} from '@whycode/core/office'
import { openOfficeArchive, readXml, type OfficeArchive } from './archive.ts'
import { orderedSlidePaths } from './inspect-pptx-views.ts'
import { pptxFrameSignature, pptxSlideObjects } from './pptx-shapes.ts'
import { readRelationships, relationshipTarget } from './relationships.ts'
import { validateOfficePackage } from './validate-package.ts'

const PROTECTED_PARTS: Record<OfficeFormat, readonly RegExp[]> = {
  docx: [
    /^word\/(?:styles|numbering|settings|fontTable|webSettings)\.xml$/i,
    /^word\/(?:theme|glossary)\//i,
    /^word\/(?:header|footer)\d+\.xml$/i,
    /^word\/_rels\/(?:header|footer)\d+\.xml\.rels$/i,
    /^word\/media\//i,
  ],
  pptx: [
    /^ppt\/(?:slideMasters|slideLayouts|theme|notesMasters)\//i,
    /^ppt\/(?:presProps|viewProps|tableStyles)\.xml$/i,
    /^ppt\/media\//i,
  ],
  xlsx: [
    /^xl\/(?:styles|theme\/.+|metadata)\.xml$/i,
    /^xl\/(?:charts|drawings|pivotTables|pivotCache)\//i,
    /^xl\/media\//i,
  ],
}

export async function compareOfficeTemplate(options: {
  templatePath: string
  outputPath: string
  format: OfficeFormat
}): Promise<OfficeTemplateComparison> {
  const [template, output] = await Promise.all([
    openOfficeArchive(options.templatePath, options.format),
    openOfficeArchive(options.outputPath, options.format),
  ])
  await validateOfficePackage(template)
  const templateParts = fileParts(template.entrySizes.keys())
  const outputParts = fileParts(output.entrySizes.keys())
  const protectedParts = [...templateParts].filter((name) =>
    PROTECTED_PARTS[options.format].some((pattern) => pattern.test(name)))
  const removedProtected = protectedParts.filter((name) => !outputParts.has(name))
  if (removedProtected.length > 0) {
    throw new OfficeProcessingError(
      'corrupted',
      `模板构建删除了共享版式或媒体部件：${removedProtected.slice(0, 10).join('、')}`,
    )
  }
  await validateOfficePackage(output)
  const modifiedProtectedParts: string[] = []
  for (const name of protectedParts) {
    const [before, after] = await Promise.all([
      template.zip.file(name)!.async('uint8array'),
      output.zip.file(name)!.async('uint8array'),
    ])
    if (sha256(before) !== sha256(after)) modifiedProtectedParts.push(name)
  }
  if (modifiedProtectedParts.length > 0) {
    throw new OfficeProcessingError(
      'corrupted',
      `模板构建改写了共享版式或媒体部件：${modifiedProtectedParts.slice(0, 10).join('、')}`,
    )
  }
  if (options.format === 'docx') await requireDocxTemplateAnchors(template, output)
  if (options.format === 'pptx') await requirePptxTemplateLineage(template, output)
  return {
    templateSha256: template.sha256,
    templatePartCount: templateParts.size,
    outputPartCount: outputParts.size,
    addedPartCount: differenceSize(outputParts, templateParts),
    removedPartCount: differenceSize(templateParts, outputParts),
    protectedPartCount: protectedParts.length,
    modifiedProtectedParts: [],
  }
}

async function requireDocxTemplateAnchors(
  template: OfficeArchive,
  output: OfficeArchive,
): Promise<void> {
  const [before, after] = await Promise.all([
    readXml(template, 'word/document.xml'),
    readXml(output, 'word/document.xml'),
  ])
  const anchors = [
    ['分节版式', /<w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr>/gi],
    ['表格结构', /<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>/gi],
    ['图形锚点', /<wp:(inline|anchor)\b[^>]*>[\s\S]*?<\/wp:\1>/gi],
  ] as const
  for (const [label, pattern] of anchors) {
    const expected = fragments(before, pattern)
    if (expected.length > 0 && !containsSignatures(fragments(after, pattern), expected)) {
      throw new OfficeProcessingError('corrupted', `DOCX 输出没有保留模板的${label}`)
    }
  }
}

async function requirePptxTemplateLineage(
  template: OfficeArchive,
  output: OfficeArchive,
): Promise<void> {
  const [templatePresentation, outputPresentation] = await Promise.all([
    readXml(template, 'ppt/presentation.xml'),
    readXml(output, 'ppt/presentation.xml'),
  ])
  const [templateSlides, outputSlides] = await Promise.all([
    orderedSlidePaths(template, templatePresentation),
    orderedSlidePaths(output, outputPresentation),
  ])
  const templateFramesByLayout = new Map<string, string[][]>()
  for (const path of templateSlides) {
    const layoutPath = await slideLayoutPath(template, path)
    const candidates = templateFramesByLayout.get(layoutPath) ?? []
    candidates.push(slideFrameSignatures(await readXml(template, path)))
    templateFramesByLayout.set(layoutPath, candidates)
  }
  for (const path of outputSlides) {
    const relsPath = relationshipPath(path)
    const relationships = await readRelationships(output, relsPath)
    const layout = relationships.find((relationship) => !relationship.external
      && relationship.type.endsWith('/slideLayout'))
    if (!layout) throw new OfficeProcessingError('corrupted', `PPTX 幻灯片没有版式关系：${path}`)
    const layoutPath = relationshipTarget(relsPath, layout.target)
    const [before, after] = await Promise.all([
      template.zip.file(layoutPath)?.async('uint8array'),
      output.zip.file(layoutPath)?.async('uint8array'),
    ])
    if (!before || !after || sha256(before) !== sha256(after)) {
      throw new OfficeProcessingError('corrupted', `PPTX 幻灯片没有沿用模板版式：${path}`)
    }
    const actualFrames = slideFrameSignatures(await readXml(output, path))
    const candidates = templateFramesByLayout.get(layoutPath) ?? []
    if (!candidates.some((sourceFrames) => inheritedFrameSubset(actualFrames, sourceFrames))) {
      throw new OfficeProcessingError('corrupted', `PPTX 幻灯片不是从模板源页复制后原位编辑：${path}`)
    }
  }
}

async function slideLayoutPath(archive: OfficeArchive, slidePath: string): Promise<string> {
  const relsPath = relationshipPath(slidePath)
  const relationships = await readRelationships(archive, relsPath)
  const layout = relationships.find((relationship) => !relationship.external
    && relationship.type.endsWith('/slideLayout'))
  if (!layout) {
    throw new OfficeProcessingError('corrupted', `PPTX 幻灯片没有版式关系：${slidePath}`)
  }
  return relationshipTarget(relsPath, layout.target)
}

function inheritedFrameSubset(actual: readonly string[], source: readonly string[]): boolean {
  // Source-content objects may be deleted, while additions and reordering would break lineage.
  // An empty result only inherits a source slide that was already empty.
  if (actual.length === 0) return source.length === 0
  let sourcePosition = 0
  for (const signature of actual) {
    const match = source.indexOf(signature, sourcePosition)
    if (match < 0) return false
    sourcePosition = match + 1
  }
  return true
}

function fragments(xml: string, pattern: RegExp): string[] {
  pattern.lastIndex = 0
  return [...xml.matchAll(pattern)].map((match) => normalizedTemplateXml(match[0]))
}

function containsSignatures(actual: readonly string[], expected: readonly string[]): boolean {
  const remaining = [...actual]
  for (const signature of expected) {
    const index = remaining.indexOf(signature)
    if (index < 0) return false
    remaining.splice(index, 1)
  }
  return true
}

function normalizedTemplateXml(xml: string): string {
  return xml
    .replace(/<w:t\b[^>]*>[\s\S]*?<\/w:t>/gi, '<w:t/>')
    .replace(/\s+w:rsid\w+=(?:"[^"]*"|'[^']*')/gi, '')
    .replace(/>\s+</g, '><')
    .trim()
}

function slideFrameSignatures(xml: string): string[] {
  return pptxSlideObjects(xml).map(pptxFrameSignature)
}

function relationshipPath(partPath: string): string {
  const separator = partPath.lastIndexOf('/')
  const directory = partPath.slice(0, separator)
  const name = partPath.slice(separator + 1)
  return `${directory}/_rels/${name}.rels`
}

function fileParts(values: Iterable<string>): Set<string> {
  return new Set([...values].filter((name) => !name.endsWith('/')))
}

function differenceSize(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let count = 0
  for (const value of left) if (!right.has(value)) count++
  return count
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
