import { OfficeProcessingError } from '@whycode/core/office'
import {
  pptxRelationshipIds,
  pptxSlideObjects,
  type PptxSlideObject,
} from './pptx-shapes.ts'
import {
  hasImage,
  isDelete,
  isKeep,
  isTextEdit,
  type SlideEdit,
} from './template-pptx-plan.ts'
import { xmlAttribute } from './template-pptx-package.ts'

export interface AppliedSlideEdits {
  removedRelationshipIds: Set<string>
  xml: string
}

export function applySlideEdits(xml: string, edits: readonly SlideEdit[]): AppliedSlideEdits {
  const objects = validateSlideEditPlan(xml, edits)
  const byId = new Map(objects.map((object) => [object.shapeId, object]))
  const deletions = edits.filter(isDelete)
    .map((edit) => byId.get(edit.shapeId)!)
    .sort((left, right) => right.start - left.start)
  const removedRelationshipIds = new Set<string>()
  let output = xml
  for (const object of deletions) {
    pptxRelationshipIds(object.xml).forEach((id) => removedRelationshipIds.add(id))
    output = `${output.slice(0, object.start)}${output.slice(object.end)}`
  }
  for (const edit of edits.filter(isTextEdit)) {
    output = replaceObjectById(output, edit.shapeId, (block) => {
      if ('text' in edit) return replaceTextRuns(block, [edit.text])
      if ('runs' in edit) return replaceTextRuns(block, edit.runs)
      return replaceParagraphs(block, edit.paragraphs)
    })
  }
  return { removedRelationshipIds, xml: output }
}

export function imageRelationshipId(xml: string, shapeId: string): string {
  const object = uniqueObject(xml, shapeId)
  if (object.tag !== 'pic') {
    throw new OfficeProcessingError('invalid-range', `PPTX 模板 shape[${shapeId}] 不是图片对象`)
  }
  const relationshipId = xmlAttribute(
    /<a:blip\b([^>]*)/iu.exec(object.xml)?.[1] ?? '',
    'r:embed',
  )
  if (!relationshipId) {
    throw new OfficeProcessingError('invalid-range', `PPTX 模板图片 shape[${shapeId}] 不是内嵌图片`)
  }
  return relationshipId
}

export function replaceImageRelationshipId(xml: string, shapeId: string, id: string): string {
  return replaceObjectById(xml, shapeId, (block) => {
    let matches = 0
    const output = block.replace(/<a:blip\b([^>]*)/iu, (whole, attributes: string) => {
      matches++
      return `<a:blip${setXmlAttribute(attributes, 'r:embed', id)}`
    })
    if (matches !== 1) {
      throw new OfficeProcessingError(
        'invalid-range',
        `PPTX 模板图片 shape[${shapeId}] 内嵌关系命中 ${matches} 次`,
      )
    }
    return output
  })
}

export function updateSlideNumberFields(xml: string, slideNumber: number): string {
  return xml.replace(/<a:fld\b([^>]*)>[\s\S]*?<\/a:fld>/giu, (field, attributes: string) => {
    if (xmlAttribute(attributes, 'type')?.toLowerCase() !== 'slidenum') return field
    return field.replace(
      /<a:t\b([^>]*)>[\s\S]*?<\/a:t>/iu,
      (_text, textAttributes: string) => `<a:t${textAttributes}>${slideNumber}</a:t>`,
    )
  })
}

function validateSlideEditPlan(xml: string, edits: readonly SlideEdit[]): PptxSlideObject[] {
  const objects = pptxSlideObjects(xml)
  const byId = new Map<string, PptxSlideObject>()
  for (const object of objects) {
    if (byId.has(object.shapeId)) {
      throw new OfficeProcessingError('corrupted', `PPTX 模板 shape[${object.shapeId}] ID 重复`)
    }
    byId.set(object.shapeId, object)
  }
  const editsById = new Map(edits.map((edit) => [edit.shapeId, edit]))
  for (const edit of edits) {
    const object = byId.get(edit.shapeId)
    if (!object) {
      throw new OfficeProcessingError('invalid-range', `PPTX 模板不存在 shape[${edit.shapeId}]`)
    }
    validateEditTarget(edit, object, objects)
    validateAncestorActions(edit, object, editsById)
  }
  for (const object of objects.filter((entry) => entry.mediaKind)) {
    const actions = [object.shapeId, ...object.parentGroupIds]
      .map((id) => editsById.get(id))
      .filter((edit): edit is SlideEdit => Boolean(edit))
      .filter(isMediaAction)
    if (actions.length !== 1) {
      throw new OfficeProcessingError(
        'invalid-range',
        `PPTX 模板媒体 shape[${object.shapeId}] 必须由一个 keep、image 或 delete 动作明确处置，当前 ${actions.length} 个`,
      )
    }
    const action = actions[0]!
    if (hasImage(action) && action.shapeId !== object.shapeId) {
      throw new OfficeProcessingError('invalid-range', '图片替换动作必须直接指向图片 shape')
    }
    if (isDelete(action) && !action.mediaRole) {
      throw new OfficeProcessingError(
        'invalid-range',
        `删除媒体 shape[${object.shapeId}] 时必须声明 mediaRole`,
      )
    }
  }
  return objects
}

function validateEditTarget(
  edit: SlideEdit,
  object: PptxSlideObject,
  objects: readonly PptxSlideObject[],
): void {
  const descendantMedia = object.tag === 'grpSp'
    && objects.some((entry) => entry.mediaKind && entry.parentGroupIds.includes(object.shapeId))
  if (hasImage(edit) && object.mediaKind !== 'image') {
    throw new OfficeProcessingError('invalid-range', `image 必须指向图片 shape[${object.shapeId}]`)
  }
  if (isKeep(edit) && !object.mediaKind && !descendantMedia) {
    throw new OfficeProcessingError('invalid-range', `keep 必须指向媒体 shape 或包含媒体的 group`)
  }
  if (isDelete(edit) && (object.mediaKind || descendantMedia) && !edit.mediaRole) {
    throw new OfficeProcessingError('invalid-range', `删除媒体对象 shape[${object.shapeId}] 必须声明 mediaRole`)
  }
  if (isTextEdit(edit) && object.tag === 'grpSp') {
    throw new OfficeProcessingError('invalid-range', '文字编辑必须直接指向 group 内的文字 shape')
  }
}

function validateAncestorActions(
  edit: SlideEdit,
  object: PptxSlideObject,
  editsById: ReadonlyMap<string, SlideEdit>,
): void {
  for (const groupId of object.parentGroupIds) {
    const ancestor = editsById.get(groupId)
    if (ancestor && isDelete(ancestor)) {
      throw new OfficeProcessingError(
        'invalid-range',
        `shape[${object.shapeId}] 位于已删除的 group shape[${groupId}] 内，不应重复编辑`,
      )
    }
    if (ancestor && isKeep(ancestor) && isMediaAction(edit)) {
      throw new OfficeProcessingError(
        'invalid-range',
        `group shape[${groupId}] 已整体 keep，内部媒体 shape[${object.shapeId}] 不应重复处置`,
      )
    }
  }
}

function isMediaAction(edit: SlideEdit): boolean {
  return hasImage(edit) || isDelete(edit) || isKeep(edit)
}

function uniqueObject(xml: string, shapeId: string): PptxSlideObject {
  const matches = pptxSlideObjects(xml).filter((object) => object.shapeId === shapeId)
  if (matches.length !== 1) {
    throw new OfficeProcessingError(
      'invalid-range',
      `PPTX 模板对象 shape[${shapeId}] 命中 ${matches.length} 次，要求唯一`,
    )
  }
  return matches[0]!
}

function replaceObjectById(
  xml: string,
  shapeId: string,
  transform: (block: string) => string,
): string {
  const object = uniqueObject(xml, shapeId)
  const replacement = transform(object.xml)
  return `${xml.slice(0, object.start)}${replacement}${xml.slice(object.end)}`
}

function replaceTextRuns(block: string, values: readonly string[]): string {
  let position = 0
  const output = block.replace(/<a:t\b([^>]*)>[\s\S]*?<\/a:t>/giu, (_match, attributes: string) => {
    const value = values[position] ?? ''
    position++
    return `<a:t${preserveSpaceAttribute(attributes, value)}>${escapeXml(value)}</a:t>`
  })
  if (position === 0) throw new OfficeProcessingError('invalid-range', 'PPTX 模板对象不是可编辑文字对象')
  if (values.length > position) {
    throw new OfficeProcessingError('invalid-range', 'PPTX runs 数量超过模板文字 run 数量')
  }
  return output
}

function replaceParagraphs(block: string, values: readonly string[]): string {
  if (values.length === 0) throw new OfficeProcessingError('invalid-range', 'PPTX paragraphs 不能为空')
  let matches = 0
  const output = block.replace(
    /<p:txBody\b([^>]*)>([\s\S]*?)<\/p:txBody>/iu,
    (_whole, attributes: string, body: string) => {
      matches++
      const paragraphs = [...body.matchAll(/<a:p\b[^>]*>[\s\S]*?<\/a:p>/giu)]
        .map((match) => match[0])
      if (paragraphs.length === 0) {
        throw new OfficeProcessingError('invalid-range', 'PPTX 模板文字对象没有段落样式可复用')
      }
      const prefixEnd = body.indexOf(paragraphs[0]!)
      const suffixStart = body.lastIndexOf(paragraphs.at(-1)!) + paragraphs.at(-1)!.length
      const rendered = values.map((value, index) => replaceTextRuns(
        paragraphs[Math.min(index, paragraphs.length - 1)]!,
        [value],
      )).join('')
      return `<p:txBody${attributes}>${body.slice(0, prefixEnd)}${rendered}${body.slice(suffixStart)}</p:txBody>`
    },
  )
  if (matches !== 1) {
    throw new OfficeProcessingError('invalid-range', 'PPTX 模板对象不是可编辑段落对象')
  }
  return output
}

function preserveSpaceAttribute(attributes: string, value: string): string {
  const without = attributes.replace(/\s+xml:space=(?:"[^"]*"|'[^']*')/giu, '')
  return `${without}${/^\s|\s$/u.test(value) ? ' xml:space="preserve"' : ''}`
}

function setXmlAttribute(attributes: string, name: string, value: string): string {
  const escaped = name.replace(':', '\\:')
  const pattern = new RegExp(`(\\s${escaped}=)(["'])[^"']*\\2`, 'iu')
  if (pattern.test(attributes)) return attributes.replace(pattern, `$1"${value}"`)
  return `${attributes} ${name}="${value}"`
}

function escapeXml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
}
