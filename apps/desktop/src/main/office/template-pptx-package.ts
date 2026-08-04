import { posix } from 'node:path'
import JSZip from 'jszip'
import { OfficeProcessingError } from '@whycode/core/office'
import type { ImageExtension } from './template-pptx-plan.ts'

export interface Relationship {
  id: string
  target: string
  type: string
}

export function orderedSlides(
  presentation: string,
  relationships: readonly Relationship[],
  relsPath: string,
): string[] {
  const byId = new Map(relationships.map((entry) => [entry.id, entry]))
  return [...presentation.matchAll(/<p:sldId\b([^>]*)\/?\s*>/gi)].map((match) => {
    const relationshipId = xmlAttribute(match[1] ?? '', 'r:id')
    const relationship = relationshipId ? byId.get(relationshipId) : undefined
    if (!relationship || !relationship.type.endsWith('/slide')) {
      throw new OfficeProcessingError('corrupted', 'PPTX 模板幻灯片顺序关系缺失')
    }
    return resolveRelationshipTarget(relsPath, relationship.target)
  })
}

export function parseRelationships(xml: string): Relationship[] {
  return [...xml.matchAll(/<Relationship\b([^>]*?)(?:\/\s*)?>/gi)].map((match) => {
    const attributes = match[1] ?? ''
    return {
      id: xmlAttribute(attributes, 'Id') ?? '',
      target: xmlAttribute(attributes, 'Target') ?? '',
      type: xmlAttribute(attributes, 'Type') ?? '',
    }
  })
}

export function replaceRelationshipTarget(xml: string, typeSuffix: string, target: string): string {
  let matches = 0
  const output = replaceRelationships(xml, (whole, attributes) => {
    if (!(xmlAttribute(attributes, 'Type') ?? '').endsWith(typeSuffix)) return whole
    matches++
    return `<Relationship${setAttribute(attributes, 'Target', target)}/>`
  })
  if (matches !== 1) {
    throw new OfficeProcessingError('corrupted', `PPTX 关系 ${typeSuffix} 命中 ${matches} 次`)
  }
  return output
}

export function replaceRelationshipTargetById(xml: string, id: string, target: string): string {
  let matches = 0
  const output = replaceRelationships(xml, (whole, attributes) => {
    if (xmlAttribute(attributes, 'Id') !== id) return whole
    matches++
    return `<Relationship${setAttribute(attributes, 'Target', target)}/>`
  })
  if (matches !== 1) {
    throw new OfficeProcessingError('corrupted', `PPTX 图片关系 ${id} 命中 ${matches} 次`)
  }
  return output
}

export function removeRelationshipsById(xml: string, ids: ReadonlySet<string>): string {
  if (ids.size === 0) return xml
  return replaceRelationships(xml, (whole, attributes) => {
    const id = xmlAttribute(attributes, 'Id')
    return id && ids.has(id) ? '' : whole
  })
}

export function appendRelationship(
  xml: string,
  relationship: { id: string; target: string; type: string },
): string {
  const entry = `<Relationship Id="${relationship.id}" Type="${relationship.type}" Target="${relationship.target}"/>`
  const output = xml.replace(/<\/Relationships>\s*$/i, `${entry}</Relationships>`)
  if (output === xml) throw new OfficeProcessingError('corrupted', 'PPTX 关系文件缺少结束标签')
  return output
}

export function addOverride(xml: string, partName: string, contentType: string): string {
  if (xml.includes(`PartName="${partName}"`)) return xml
  const entry = `<Override PartName="${partName}" ContentType="${contentType}"/>`
  return appendContentType(xml, entry)
}

export function addDefault(xml: string, extension: string, contentType: string): string {
  const escaped = extension.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (new RegExp(`<Default\\b[^>]*\\bExtension=["']${escaped}["']`, 'i').test(xml)) return xml
  return appendContentType(xml, `<Default Extension="${extension}" ContentType="${contentType}"/>`)
}

export async function requiredText(zip: JSZip, path: string): Promise<string> {
  const entry = zip.file(path)
  if (!entry) throw new OfficeProcessingError('corrupted', `PPTX 模板缺少 ${path}`)
  return entry.async('string')
}

export function relationshipPath(partPath: string): string {
  return `${posix.dirname(partPath)}/_rels/${posix.basename(partPath)}.rels`
}

export function relativeTarget(ownerPart: string, targetPart: string): string {
  return posix.relative(posix.dirname(ownerPart), targetPart)
}

export function maxPartNumber(zip: JSZip, pattern: RegExp): number {
  let maximum = 0
  for (const path of Object.keys(zip.files)) {
    const match = pattern.exec(path)
    if (match) maximum = Math.max(maximum, Number(match[1]))
  }
  return maximum
}

export function maxRelationshipNumber(relationships: readonly Relationship[]): number {
  return relationships.reduce((maximum, relationship) => {
    const value = /^rId(\d+)$/i.exec(relationship.id)?.[1]
    return Math.max(maximum, value ? Number(value) : 0)
  }, 0)
}

export function nextRelationshipId(start: number, xml: string): string {
  let value = start
  while (new RegExp(`\\bId=["']rId${value}["']`, 'i').test(xml)) value++
  return `rId${value}`
}

export function emptyRelationships(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
}

export function uniqueMediaPath(
  zip: JSZip,
  slideNumber: number,
  imagePosition: number,
  extension: ImageExtension,
): string {
  let suffix = 0
  while (true) {
    const discriminator = suffix === 0 ? '' : `-${suffix}`
    const path = `ppt/media/whycode-${slideNumber}-${imagePosition}${discriminator}.${extension}`
    if (!zip.file(path)) return path
    suffix++
  }
}

export function xmlAttribute(attributes: string, name: string): string | null {
  const escaped = name.replace(':', '\\:')
  return new RegExp(`(?:^|\\s)${escaped}=(?:"([^"]*)"|'([^']*)')`, 'i')
    .exec(attributes)?.slice(1).find(Boolean) ?? null
}

export function resolveRelationshipTarget(relsPath: string, target: string): string {
  const ownerDirectory = posix.dirname(posix.dirname(relsPath))
  return posix.normalize(posix.join(ownerDirectory, target))
}

function replaceRelationships(
  xml: string,
  replacer: (whole: string, attributes: string) => string,
): string {
  return xml.replace(
    /<Relationship\b([^>]*?)(?:\/\s*)?>/gi,
    (whole, attributes: string) => replacer(whole, attributes),
  )
}

function appendContentType(xml: string, entry: string): string {
  const output = xml.replace(/<\/Types>\s*$/i, `${entry}</Types>`)
  if (output === xml) throw new OfficeProcessingError('corrupted', 'PPTX Content Types 缺少结束标签')
  return output
}

function setAttribute(attributes: string, name: string, value: string): string {
  const pattern = new RegExp(`(\\s${name}=)(["'])[^"']*\\2`, 'i')
  if (pattern.test(attributes)) return attributes.replace(pattern, `$1"${escapeXml(value)}"`)
  return `${attributes} ${name}="${escapeXml(value)}"`
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
