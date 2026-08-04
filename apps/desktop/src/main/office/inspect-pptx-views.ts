import { posix } from 'node:path'
import {
  OfficeProcessingError,
  type OfficeInspectionUnit,
} from '@whycode/core/office'
import type { OfficeArchive } from './archive.ts'
import { readXml, sortedEntries } from './archive.ts'
import {
  inspectPptxResources,
  pptxResourceLines,
  type PptxInspectedObject,
} from './inspect-pptx-resources.ts'
import { readRelationships, relationshipTarget } from './relationships.ts'
import { attributeValue, boundedText, elementTexts, normalizeText } from './xml.ts'

export async function orderedSlidePaths(
  archive: OfficeArchive,
  presentation: string,
): Promise<string[]> {
  const relationships = await readRelationships(archive, 'ppt/_rels/presentation.xml.rels')
  const byId = new Map(relationships.filter((item) => !item.external).map((item) => [item.id, item]))
  const paths: string[] = []
  for (const match of presentation.matchAll(/<p:sldId\b([^>]*)\/?\s*>/gi)) {
    const relationshipId = attributeValue(match[1] ?? '', 'r:id')
    const relationship = relationshipId ? byId.get(relationshipId) : undefined
    if (!relationship) throw new OfficeProcessingError('corrupted', 'PPTX 幻灯片顺序关系缺失')
    const path = relationshipTarget('ppt/_rels/presentation.xml.rels', relationship.target)
    if (!archive.zip.file(path)) throw new OfficeProcessingError('corrupted', `PPTX 缺少幻灯片：${path}`)
    paths.push(path)
  }
  return paths
}

export async function pptxObjectUnits(
  archive: OfficeArchive,
  slidePaths: readonly string[],
  slideNumber?: number,
): Promise<OfficeInspectionUnit[]> {
  const units: OfficeInspectionUnit[] = []
  const resourceIndex = await inspectPptxResources(archive, slidePaths)
  for (const [slidePosition, path] of selectedSlides(slidePaths, slideNumber)) {
    addSlideObjects(units, resourceIndex.get(path) ?? [], path, slidePosition + 1)
    await addNotes(units, archive, path, slidePosition + 1)
  }
  return units.map((unit, position) => ({ ...unit, index: position + 1 }))
}

export async function pptxStyleUnits(archive: OfficeArchive): Promise<OfficeInspectionUnit[]> {
  const units: OfficeInspectionUnit[] = []
  for (const entry of sortedEntries(archive.zip, /^ppt\/(?:slideMasters|slideLayouts)\/[^/]+\.xml$/i)) {
    const xml = await readXml(archive, entry.name)
    const name = attributeValue(/<p:cSld\b([^>]*)>/i.exec(xml)?.[1] ?? '', 'name')
    const placeholders = [...xml.matchAll(/<p:ph\b/gi)].length
    const shapes = [...xml.matchAll(/<p:(?:sp|pic|graphicFrame|cxnSp)\b/gi)].length
    units.push({
      index: units.length + 1,
      label: `${entry.name.includes('/slideMasters/') ? '母版' : '版式'}：${name ?? posix.basename(entry.name)}`,
      kind: entry.name.includes('/slideMasters/') ? 'slide-master' : 'slide-layout',
      locator: entry.name,
      text: `对象 ${shapes}；占位符 ${placeholders}；文字：${boundedText(normalizeText(elementTexts(xml, 'a:t').join(' | ')) || '（空）', 10_000)}`,
    })
  }
  for (const entry of sortedEntries(archive.zip, /^ppt\/theme\/theme\d+\.xml$/i)) {
    const xml = await readXml(archive, entry.name)
    const themeName = attributeValue(/<a:theme\b([^>]*)>/i.exec(xml)?.[1] ?? '', 'name')
    const majorLatin = attributeValue(/<a:majorFont\b[\s\S]*?<a:latin\b([^>]*)/i.exec(xml)?.[1] ?? '', 'typeface')
    const minorLatin = attributeValue(/<a:minorFont\b[\s\S]*?<a:latin\b([^>]*)/i.exec(xml)?.[1] ?? '', 'typeface')
    const colors = [...xml.matchAll(/<a:(?:srgbClr|sysClr)\b([^>]*)/gi)]
      .map((match) => attributeValue(match[1] ?? '', 'val') ?? attributeValue(match[1] ?? '', 'lastClr'))
      .filter((value): value is string => Boolean(value))
    units.push({
      index: units.length + 1,
      label: `主题：${themeName ?? posix.basename(entry.name)}`,
      kind: 'theme',
      locator: entry.name,
      text: `主字体：${majorLatin ?? '未声明'}；正文字体：${minorLatin ?? '未声明'}；颜色：${colors.slice(0, 16).join('、') || '未声明'}`,
    })
  }
  return units
}

export async function pptxTemplateUnits(
  archive: OfficeArchive,
  slidePaths: readonly string[],
  slideNumber?: number,
): Promise<OfficeInspectionUnit[]> {
  const units: OfficeInspectionUnit[] = []
  const resourceIndex = await inspectPptxResources(archive, slidePaths)
  for (const [slidePosition, path] of selectedSlides(slidePaths, slideNumber)) {
    const objects = resourceIndex.get(path) ?? []
    const relsPath = `${posix.dirname(path)}/_rels/${posix.basename(path)}.rels`
    const relationships = await readRelationships(archive, relsPath)
    const layout = relationships.find((item) => !item.external && item.type.endsWith('/slideLayout'))
    if (!layout) throw new OfficeProcessingError('corrupted', `PPTX 幻灯片缺少版式关系：${path}`)
    const layoutPath = relationshipTarget(relsPath, layout.target)
    const layoutXml = await readXml(archive, layoutPath)
    const layoutName = attributeValue(/<p:cSld\b([^>]*)>/i.exec(layoutXml)?.[1] ?? '', 'name')
      ?? posix.basename(layoutPath)
    const slots: string[] = []
    const objectCount = objects.length
    for (const object of objects) {
      const body = object.xml
      if (object.tag === 'grpSp') {
        const members = objects
          .filter((candidate) => candidate.parentGroupIds.includes(object.shapeId))
          .map((candidate) => candidate.shapeId)
        slots.push([
          `shape[${object.shapeId}] ${object.name ?? '未命名'}`,
          '类型 group',
          `组成员 shape ID ${members.join(', ') || '无'}`,
        ].join('；'))
        continue
      }
      const properties = /<p:cNvPr\b([^>]*)/i.exec(body)?.[1] ?? ''
      const placeholder = /<p:ph\b([^>]*)/i.exec(body)?.[1] ?? ''
      const text = normalizeText(elementTexts(body, 'a:t').join(' | '))
      const resourceIds = object.resources.map((resource) => resource.relationshipId)
      if (!text && !placeholder && resourceIds.length === 0) continue
      const transform = /<(?:a|p):xfrm\b[^>]*>([\s\S]*?)<\/(?:a|p):xfrm>/i.exec(body)?.[1] ?? ''
      const offset = /<a:off\b([^>]*)/i.exec(transform)?.[1] ?? ''
      const extent = /<a:ext\b([^>]*)/i.exec(transform)?.[1] ?? ''
      slots.push([
        `shape[${object.shapeId}] ${object.name ?? '未命名'}`,
        `类型 ${object.tag.toLowerCase()}`,
        `占位符 ${attributeValue(placeholder, 'type') ?? '否'}${attributeValue(placeholder, 'idx') ? `(${attributeValue(placeholder, 'idx')})` : ''}`,
        `位置 ${attributeValue(offset, 'x') ?? '?'}，${attributeValue(offset, 'y') ?? '?'}；尺寸 ${attributeValue(extent, 'cx') ?? '?'}×${attributeValue(extent, 'cy') ?? '?'}`,
        `资源 ${resourceIds.join(', ') || '无'}；替代文字 ${attributeValue(properties, 'descr') ?? attributeValue(properties, 'title') ?? '缺失'}`,
        ...pptxResourceLines(object),
        ...(text ? [textFormat(body)] : []),
        `文字 ${text || '（空）'}`,
      ].join('；'))
    }
    units.push({
      index: units.length + 1,
      label: `模板源页 ${slidePosition + 1}：${layoutName}`,
      kind: 'template-slide',
      locator: path,
      text: boundedText([
        `版式：${layoutPath}；对象 ${objectCount}；可编辑文字/媒体槽 ${slots.length}`,
        ...slots,
      ].join('\n'), 20_000),
    })
  }
  return units
}

function addSlideObjects(
  units: OfficeInspectionUnit[],
  objects: readonly PptxInspectedObject[],
  slidePath: string,
  slideNumber: number,
): void {
  for (const object of objects) {
    const body = object.xml
    const properties = /<p:cNvPr\b([^>]*)\/?\s*>/i.exec(body)?.[1] ?? ''
    const placeholder = /<p:ph\b([^>]*)\/?\s*>/i.exec(body)?.[1] ?? ''
    const transform = /<a:xfrm\b[^>]*>([\s\S]*?)<\/a:xfrm>/i.exec(body)?.[1]
      ?? /<p:xfrm\b[^>]*>([\s\S]*?)<\/p:xfrm>/i.exec(body)?.[1]
      ?? ''
    const offset = /<a:off\b([^>]*)\/?\s*>/i.exec(transform)?.[1] ?? ''
    const extent = /<a:ext\b([^>]*)\/?\s*>/i.exec(transform)?.[1] ?? ''
    const text = object.tag === 'grpSp' ? '' : normalizeText(elementTexts(body, 'a:t').join(' | '))
    const members = object.tag === 'grpSp'
      ? objects.filter((candidate) => candidate.parentGroupIds.includes(object.shapeId))
        .map((candidate) => candidate.shapeId)
      : []
    const relationshipIds = object.resources.map((resource) => resource.relationshipId)
    units.push({
      index: units.length + 1,
      label: `幻灯片 ${slideNumber} 对象：${object.name ?? object.shapeId}`,
      kind: objectKind(object),
      locator: `${slidePath}#shape[${object.shapeId}]`,
      text: boundedText([
        `ID：${object.shapeId}；占位符：${attributeValue(placeholder, 'type') ?? '否'}${attributeValue(placeholder, 'idx') ? `(${attributeValue(placeholder, 'idx')})` : ''}`,
        `父级组：${object.parentGroupIds.join(', ') || '无'}`,
        `位置：${attributeValue(offset, 'x') ?? '?'}，${attributeValue(offset, 'y') ?? '?'}；尺寸：${attributeValue(extent, 'cx') ?? '?'}×${attributeValue(extent, 'cy') ?? '?'} EMU`,
        ...(object.tag === 'grpSp'
          ? [`组成员 shape ID：${members.join(', ') || '无'}`]
          : [`资源关系：${relationshipIds.join(', ') || '无'}`]),
        ...pptxResourceLines(object),
        `替代文字：${attributeValue(properties, 'descr') ?? attributeValue(properties, 'title') ?? '缺失'}`,
        ...(text ? [textFormat(body)] : []),
        `文字：${text || '（空）'}`,
      ].join('\n'), 20_000),
    })
  }
}

function textFormat(body: string): string {
  const runProperties = /<a:(?:rPr|defRPr)\b([^>]*)/i.exec(body)?.[1] ?? ''
  const paragraphProperties = /<a:pPr\b([^>]*)/i.exec(body)?.[1] ?? ''
  const typeface = attributeValue(/<a:latin\b([^>]*)/i.exec(body)?.[1] ?? '', 'typeface')
  const color = attributeValue(/<a:srgbClr\b([^>]*)/i.exec(body)?.[1] ?? '', 'val')
    ?? attributeValue(/<a:schemeClr\b([^>]*)/i.exec(body)?.[1] ?? '', 'val')
  const size = Number(attributeValue(runProperties, 'sz'))
  return [
    `格式 字体 ${typeface ?? '继承'}`,
    `字号 ${Number.isFinite(size) && size > 0 ? `${size / 100}pt` : '继承'}`,
    `颜色 ${color ?? '继承'}`,
    `粗体 ${attributeValue(runProperties, 'b') === '1' ? '是' : '否/继承'}`,
    `对齐 ${attributeValue(paragraphProperties, 'algn') ?? '继承'}`,
    `级别 ${attributeValue(paragraphProperties, 'lvl') ?? '0'}`,
  ].join('；')
}

async function addNotes(
  units: OfficeInspectionUnit[],
  archive: OfficeArchive,
  slidePath: string,
  slideNumber: number,
): Promise<void> {
  const relationshipPath = `${posix.dirname(slidePath)}/_rels/${posix.basename(slidePath)}.rels`
  if (!archive.zip.file(relationshipPath)) return
  const relationships = await readRelationships(archive, relationshipPath)
  const notes = relationships.find((item) => !item.external && item.type.endsWith('/notesSlide'))
  if (!notes) return
  const path = relationshipTarget(relationshipPath, notes.target)
  const xml = await readXml(archive, path)
  const text = normalizeText(elementTexts(xml, 'a:t').join(' | '))
  units.push({
    index: units.length + 1,
    label: `幻灯片 ${slideNumber} 备注`,
    kind: 'notes',
    locator: path,
    text: boundedText(text || '（空）', 20_000),
  })
}

function selectedSlides(
  paths: readonly string[],
  slideNumber?: number,
): Array<[number, string]> {
  if (slideNumber === undefined) return paths.map((path, position) => [position, path])
  const path = paths[slideNumber - 1]
  if (!path) throw new OfficeProcessingError('invalid-range', `PPTX 不存在幻灯片 ${slideNumber}`)
  return [[slideNumber - 1, path]]
}

function objectKind(object: PptxInspectedObject): string {
  if (object.mediaKind) return object.mediaKind
  if (object.tag === 'cxnSp') return 'connector'
  if (object.tag === 'grpSp') return 'group'
  if (/<a:tbl\b/i.test(object.xml)) return 'table'
  return object.tag === 'sp' ? 'shape' : 'graphic-frame'
}
