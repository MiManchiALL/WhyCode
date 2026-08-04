import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type { OfficeArchive } from './archive.ts'
import {
  pptxImageCrop,
  pptxRelationshipIds,
  pptxSlideObjects,
  type PptxSlideObject,
} from './pptx-shapes.ts'
import { readRelationships, relationshipTarget } from './relationships.ts'
import { readXml } from './archive.ts'

export interface PptxObjectResource {
  byteLength: number | null
  external: boolean
  relationshipId: string
  relationshipType: string
  reuseCount: number
  sha256: string | null
  target: string
}

export interface PptxInspectedObject extends PptxSlideObject {
  crop: string | null
  resources: PptxObjectResource[]
}

export type PptxResourceIndex = ReadonlyMap<string, readonly PptxInspectedObject[]>

interface PendingResource extends Omit<PptxObjectResource, 'reuseCount'> {
  reuseKey: string
}

const RESOURCE_RELATIONSHIPS = /\/(?:audio|chart|diagramData|diagramLayout|diagramQuickStyle|diagramColors|image|media|oleObject|package|video)$/iu

export async function inspectPptxResources(
  archive: OfficeArchive,
  slidePaths: readonly string[],
): Promise<PptxResourceIndex> {
  const pendingBySlide = new Map<string, Array<PptxSlideObject & {
    crop: string | null
    resources: PendingResource[]
  }>>()
  const reuseCounts = new Map<string, number>()
  const partDetails = new Map<string, Promise<{ byteLength: number | null; sha256: string | null }>>()

  for (const slidePath of slidePaths) {
    const xml = await readXml(archive, slidePath)
    const relsPath = `${posix.dirname(slidePath)}/_rels/${posix.basename(slidePath)}.rels`
    const relationships = new Map((await readRelationships(archive, relsPath))
      .map((relationship) => [relationship.id, relationship]))
    const inspected = []
    for (const object of pptxSlideObjects(xml)) {
      const resources: PendingResource[] = []
      if (object.tag !== 'grpSp') {
        for (const relationshipId of pptxRelationshipIds(object.xml)) {
          const relationship = relationships.get(relationshipId)
          if (!relationship || !RESOURCE_RELATIONSHIPS.test(relationship.type)) continue
          const target = relationship.external
            ? relationship.target
            : relationshipTarget(relsPath, relationship.target)
          const reuseKey = `${relationship.external ? 'external' : 'internal'}:${target}`
          reuseCounts.set(reuseKey, (reuseCounts.get(reuseKey) ?? 0) + 1)
          const details = relationship.external
            ? { byteLength: null, sha256: null }
            : await cachedPartDetails(archive, target, partDetails)
          resources.push({
            ...details,
            external: relationship.external,
            relationshipId,
            relationshipType: posix.basename(relationship.type),
            reuseKey,
            sha256: details.sha256,
            target,
          })
        }
      }
      inspected.push({
        ...object,
        crop: object.mediaKind === 'image' ? pptxImageCrop(object.xml) : null,
        resources,
      })
    }
    pendingBySlide.set(slidePath, inspected)
  }

  return new Map([...pendingBySlide].map(([slidePath, objects]) => [
    slidePath,
    objects.map(({ resources, ...object }) => ({
      ...object,
      resources: resources.map(({ reuseKey, ...resource }) => ({
        ...resource,
        reuseCount: reuseCounts.get(reuseKey) ?? 0,
      })),
    })),
  ]))
}

export function pptxResourceLines(object: PptxInspectedObject): string[] {
  const lines = object.resources.map((resource) => [
    `Resource ${resource.relationshipId}: ${resource.relationshipType}`,
    `target ${resource.target}`,
    `SHA-256 ${resource.sha256 ?? (resource.external ? 'external' : 'missing')}`,
    `bytes ${resource.byteLength ?? 'n/a'}`,
    `active uses ${resource.reuseCount}`,
  ].join('; '))
  if (object.crop) lines.push(`Image crop: ${object.crop}`)
  return lines
}

async function cachedPartDetails(
  archive: OfficeArchive,
  target: string,
  cache: Map<string, Promise<{ byteLength: number | null; sha256: string | null }>>,
): Promise<{ byteLength: number | null; sha256: string | null }> {
  const existing = cache.get(target)
  if (existing) return existing
  const pending = archive.zip.file(target)?.async('uint8array').then((bytes) => ({
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  })) ?? Promise.resolve({ byteLength: null, sha256: null })
  cache.set(target, pending)
  return pending
}
