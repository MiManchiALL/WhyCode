import { posix } from 'node:path'
import {
  OfficeProcessingError,
  type OfficeValidation,
} from '@whycode/core/office'
import type { OfficeArchive } from './archive.ts'
import { readXml, sortedEntries } from './archive.ts'
import { readRelationships, relationshipTarget } from './relationships.ts'
import { validateDocxPackage } from './validate-docx.ts'
import { validatePptxPackage } from './validate-pptx.ts'
import { validateXlsxPackage } from './validate-xlsx.ts'
import type { ValidationState } from './validation-state.ts'
import { validationIssue } from './validation-state.ts'
import { attributeValue } from './xml.ts'

const MAIN_CONTENT_TYPES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
} as const
const MAIN_PARTS = {
  docx: 'word/document.xml',
  pptx: 'ppt/presentation.xml',
  xlsx: 'xl/workbook.xml',
} as const

export async function validateOfficePackage(archive: OfficeArchive): Promise<OfficeValidation> {
  const state: ValidationState = {
    archive,
    issues: [],
    relationshipCount: 0,
    internalRelationshipCount: 0,
  }
  const xmlParts = sortedEntries(archive.zip, /(?:\.xml|\.rels)$/i)
  // ZIP 的总解压预算高于单个 Utility Process 的 heap；逐件验证可避免
  // 同时保留全部 UTF-16 XML 字符串而把可诊断的超限退化成 OOM。
  for (const entry of xmlParts) await readXml(archive, entry.name)
  await validateContentTypes(state)
  await validateRelationships(state)
  if (archive.format === 'docx') await validateDocxPackage(state)
  else if (archive.format === 'pptx') await validatePptxPackage(state)
  else await validateXlsxPackage(state)
  const firstError = state.issues.find((issue) => issue.severity === 'error')
  if (firstError) {
    throw new OfficeProcessingError(
      'corrupted',
      `OOXML 深层校验失败：${firstError.location}：${firstError.message}`,
    )
  }
  return {
    checkedPartCount: xmlParts.length,
    relationshipCount: state.relationshipCount,
    internalRelationshipCount: state.internalRelationshipCount,
    issues: state.issues,
  }
}

async function validateContentTypes(state: ValidationState): Promise<void> {
  const xml = await readXml(state.archive, '[Content_Types].xml')
  const defaults = new Map<string, string>()
  const overrides = new Map<string, string>()
  for (const match of xml.matchAll(/<Default\b([^>]*)\/?\s*>/gi)) {
    addUniqueMapping(
      state,
      defaults,
      attributeValue(match[1] ?? '', 'Extension')?.toLowerCase(),
      attributeValue(match[1] ?? '', 'ContentType'),
      'content-type-default',
    )
  }
  for (const match of xml.matchAll(/<Override\b([^>]*)\/?\s*>/gi)) {
    addUniqueMapping(
      state,
      overrides,
      attributeValue(match[1] ?? '', 'PartName')?.replace(/^\//, ''),
      attributeValue(match[1] ?? '', 'ContentType'),
      'content-type-override',
    )
  }
  const mainPart = MAIN_PARTS[state.archive.format]
  if (overrides.get(mainPart) !== MAIN_CONTENT_TYPES[state.archive.format]) {
    validationIssue(state, 'content-type-main', 'error', mainPart, '主部件 ContentType 与实际格式不一致')
  }
  for (const name of overrides.keys()) {
    if (!state.archive.zip.file(name)) {
      // Office accepts redundant overrides and PptxGenJS currently emits one for multi-slide decks.
      // The absent part cannot be opened or targeted, so report package hygiene without rejecting it.
      validationIssue(state, 'content-type-target-missing', 'warning', name, 'ContentType Override 指向的部件不存在')
    }
  }
  for (const name of state.archive.entrySizes.keys()) {
    if (name === '[Content_Types].xml' || name.endsWith('/')) continue
    const extension = name.toLowerCase().endsWith('.rels')
      ? 'rels'
      : posix.extname(name).slice(1).toLowerCase()
    if (!overrides.has(name) && !defaults.has(extension)) {
      validationIssue(state, 'content-type-missing', 'error', name, '部件没有匹配的 ContentType')
    }
  }
}

async function validateRelationships(state: ValidationState): Promise<void> {
  let rootTargetsMain = false
  for (const entry of sortedEntries(state.archive.zip, /(?:^|\/)_[Rr]els\/[^/]*\.rels$/)) {
    const owner = relationshipOwner(entry.name)
    if (owner && !state.archive.zip.file(owner)) {
      validationIssue(state, 'relationship-owner-missing', 'error', entry.name, `关系所属部件不存在：${owner}`)
    }
    const relationships = await readRelationships(state.archive, entry.name)
    const ids = new Set<string>()
    for (const relationship of relationships) {
      state.relationshipCount++
      if (ids.has(relationship.id)) {
        validationIssue(state, 'relationship-id-duplicate', 'error', entry.name, `关系 ID 重复：${relationship.id}`)
      }
      ids.add(relationship.id)
      if (relationship.external) continue
      state.internalRelationshipCount++
      const target = relationshipTarget(entry.name, stripFragment(relationship.target))
      if (!state.archive.zip.file(target)) {
        validationIssue(state, 'relationship-target-missing', 'error', entry.name, `关系目标不存在：${target}`)
      }
      if (
        entry.name.toLowerCase() === '_rels/.rels'
        && relationship.type.endsWith('/officeDocument')
        && target === MAIN_PARTS[state.archive.format]
      ) rootTargetsMain = true
    }
  }
  if (!rootTargetsMain) {
    validationIssue(state, 'office-document-relationship', 'error', '_rels/.rels', '根关系没有指向格式主部件')
  }
}

function addUniqueMapping(
  state: ValidationState,
  values: Map<string, string>,
  key: string | null | undefined,
  value: string | null,
  code: string,
): void {
  if (!key || !value) {
    validationIssue(state, code, 'error', '[Content_Types].xml', 'ContentType 映射字段不完整')
    return
  }
  if (values.has(key)) {
    validationIssue(state, `${code}-duplicate`, 'error', '[Content_Types].xml', `ContentType 映射重复：${key}`)
  }
  values.set(key, value)
}

function relationshipOwner(path: string): string | null {
  if (path.toLowerCase() === '_rels/.rels') return null
  return posix.join(posix.dirname(posix.dirname(path)), posix.basename(path, '.rels'))
}

function stripFragment(target: string): string {
  return target.split('#', 1)[0] ?? target
}
