import { createHash } from 'node:crypto'
import {
  OfficeProcessingError,
  type OfficeTemplateComparison,
  type OfficeFormat,
  type PptxTemplateRequirements,
} from '@whycode/core/office'
import { openOfficeArchive, readXml, type OfficeArchive } from './archive.ts'
import { comparePptxTemplate } from './compare-pptx-template.ts'
import { validateOfficePackage } from './validate-package.ts'

const PROTECTED_PARTS: Record<OfficeFormat, readonly RegExp[]> = {
  docx: [
    /^word\/(?:styles|numbering|settings|fontTable|webSettings)\.xml$/i,
    /^word\/(?:theme|glossary)\//i,
    /^word\/(?:header|footer)\d+\.xml$/i,
    /^word\/_rels\/(?:header|footer)\d+\.xml\.rels$/i,
    /^word\/media\//i,
  ],
  pptx: [],
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
  pptxTemplateRequirements?: PptxTemplateRequirements
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
  const checks = options.format === 'pptx'
    ? await comparePptxTemplate(template, output, options.pptxTemplateRequirements)
    : ['共享版式和媒体部件保持不变']
  return {
    templateSha256: template.sha256,
    templatePartCount: templateParts.size,
    outputPartCount: outputParts.size,
    addedPartCount: differenceSize(outputParts, templateParts),
    removedPartCount: differenceSize(templateParts, outputParts),
    protectedPartCount: protectedParts.length,
    modifiedProtectedParts: [],
    checks,
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
