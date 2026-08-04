import { OfficeProcessingError } from '@whycode/core/office'
import { attributeValue } from './xml.ts'

export type PptxShapeTag = 'cxnSp' | 'graphicFrame' | 'grpSp' | 'pic' | 'sp'
export type PptxMediaKind = 'chart' | 'diagram' | 'embedded-object' | 'image' | 'media'

export interface PptxSlideObject {
  end: number
  mediaKind: PptxMediaKind | null
  name: string | null
  parentGroupIds: string[]
  shapeId: string
  start: number
  tag: PptxShapeTag
  xml: string
}

interface OpenObject {
  parentGroupStarts: number[]
  start: number
  tag: PptxShapeTag
}

interface ClosedObject extends OpenObject {
  end: number
  xml: string
}

const OBJECT_TOKEN = /<\/?p:(grpSp|graphicFrame|cxnSp|pic|sp)\b[^>]*>/giu

export function pptxSlideObjects(xml: string): PptxSlideObject[] {
  const stack: OpenObject[] = []
  const closed: ClosedObject[] = []
  for (const match of xml.matchAll(OBJECT_TOKEN)) {
    const token = match[0]
    const tag = match[1] as PptxShapeTag
    const start = match.index ?? 0
    if (token.startsWith('</')) {
      const current = stack.pop()
      if (!current || current.tag !== tag) {
        throw new OfficeProcessingError('corrupted', `PPTX 对象标签嵌套无效：${tag}`)
      }
      const end = start + token.length
      closed.push({ ...current, end, xml: xml.slice(current.start, end) })
      continue
    }
    const parentGroupStarts = stack
      .filter((entry) => entry.tag === 'grpSp')
      .map((entry) => entry.start)
    if (/\/\s*>$/u.test(token)) {
      closed.push({ start, end: start + token.length, tag, parentGroupStarts, xml: token })
      continue
    }
    stack.push({ start, tag, parentGroupStarts })
  }
  if (stack.length > 0) {
    throw new OfficeProcessingError('corrupted', 'PPTX 对象标签没有完整闭合')
  }
  const idsByStart = new Map(closed.map((entry) => [entry.start, shapeIdentity(entry.xml).id]))
  return closed
    .sort((left, right) => left.start - right.start)
    .map((entry) => {
      const identity = shapeIdentity(entry.xml)
      if (!identity.id) {
        throw new OfficeProcessingError('corrupted', `PPTX ${entry.tag} 对象缺少 shape ID`)
      }
      return {
        ...entry,
        mediaKind: mediaKind(entry.tag, entry.xml),
        name: identity.name,
        parentGroupIds: entry.parentGroupStarts
          .map((start) => idsByStart.get(start))
          .filter((id): id is string => Boolean(id)),
        shapeId: identity.id,
      }
    })
}

export function pptxFrameSignature(object: PptxSlideObject): string {
  const properties = /<p:cNvPr\b([^>]*)/iu.exec(object.xml)?.[1] ?? ''
  const placeholder = /<p:ph\b([^>]*)/iu.exec(object.xml)?.[1] ?? ''
  const transform = /<(?:a|p):xfrm\b[^>]*>([\s\S]*?)<\/(?:a|p):xfrm>/iu
    .exec(object.xml)?.[1] ?? ''
  return [
    object.tag.toLowerCase(),
    cleanAttributes(properties),
    cleanAttributes(placeholder),
    transform.replace(/>\s+</gu, '><'),
  ].join('|')
}

export function pptxRelationshipIds(xml: string): Set<string> {
  const ids = new Set<string>()
  for (const match of xml.matchAll(/\br:[A-Za-z][\w.-]*=(?:"([^"]+)"|'([^']+)')/gu)) {
    const id = match[1] ?? match[2]
    if (id) ids.add(id)
  }
  return ids
}

export function pptxRelationshipReferenceCount(xml: string, relationshipId: string): number {
  let count = 0
  for (const match of xml.matchAll(/\br:[A-Za-z][\w.-]*=(?:"([^"]+)"|'([^']+)')/gu)) {
    if ((match[1] ?? match[2]) === relationshipId) count++
  }
  return count
}

export function pptxImageCrop(xml: string): string | null {
  const attributes = /<a:srcRect\b([^>]*)\/?\s*>/iu.exec(xml)?.[1]
  if (!attributes) return null
  const values = ['l', 't', 'r', 'b'].map((name) => `${name}=${attributeValue(attributes, name) ?? '0'}`)
  return values.join(',')
}

function shapeIdentity(xml: string): { id: string | null; name: string | null } {
  const properties = /<p:cNvPr\b([^>]*)/iu.exec(xml)?.[1] ?? ''
  return {
    id: attributeValue(properties, 'id'),
    name: attributeValue(properties, 'name'),
  }
}

function mediaKind(tag: PptxShapeTag, xml: string): PptxMediaKind | null {
  if (tag === 'pic') {
    return /<p14:media\b|<a:(?:audioFile|videoFile)\b/iu.test(xml) ? 'media' : 'image'
  }
  if (tag !== 'graphicFrame') return null
  if (/<c:chart\b/iu.test(xml)) return 'chart'
  if (/<dgm:relIds\b|\/diagram(?:\/|$)/iu.test(xml)) return 'diagram'
  if (/<p:oleObj\b|\/oleObject$/iu.test(xml)) return 'embedded-object'
  if (/<p14:media\b|<a:(?:audioFile|videoFile)\b/iu.test(xml)) return 'media'
  return null
}

function cleanAttributes(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}
