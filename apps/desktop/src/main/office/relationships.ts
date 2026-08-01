import { posix } from 'node:path'
import { OfficeProcessingError } from '@whycode/core/office'
import type { OfficeArchive } from './archive.ts'
import { readXml, sortedEntries } from './archive.ts'
import { attributeValue } from './xml.ts'

export interface PackageRelationship {
  id: string
  target: string
  type: string
  external: boolean
}

export async function readRelationships(
  archive: OfficeArchive,
  relationshipPath: string,
): Promise<PackageRelationship[]> {
  const xml = await readXml(archive, relationshipPath)
  const relationships: PackageRelationship[] = []
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)) {
    const attributes = match[1] ?? ''
    const id = attributeValue(attributes, 'Id')
    const target = attributeValue(attributes, 'Target')
    const type = attributeValue(attributes, 'Type')
    if (!id || !target || !type) {
      throw new OfficeProcessingError('corrupted', `关系部件字段不完整：${relationshipPath}`)
    }
    relationships.push({
      id,
      target,
      type,
      external: attributeValue(attributes, 'TargetMode')?.toLowerCase() === 'external',
    })
  }
  return relationships
}

export function relationshipTarget(
  relationshipPath: string,
  target: string,
): string {
  const ownerDirectory = posix.dirname(posix.dirname(relationshipPath))
  const resolved = posix.normalize(posix.join(ownerDirectory, target.replaceAll('\\', '/')))
  if (resolved.startsWith('../') || resolved.startsWith('/') || resolved === '..') {
    throw new OfficeProcessingError('corrupted', 'OOXML 关系指向了包外路径')
  }
  return resolved
}

export async function countExternalRelationships(archive: OfficeArchive): Promise<number> {
  let count = 0
  for (const entry of sortedEntries(archive.zip, /(?:^|\/)_[Rr]els\/[^/]+\.rels$/)) {
    const relationships = await readRelationships(archive, entry.name)
    count += relationships.filter((relationship) => relationship.external).length
  }
  return count
}
