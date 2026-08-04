import { readXml, sortedEntries } from './archive.ts'
import type { ValidationState } from './validation-state.ts'
import { validationIssue } from './validation-state.ts'
import { attributeValue, elementTexts, normalizeText } from './xml.ts'

interface SlideObject {
  id: string
  kind: string
  x: number
  y: number
  width: number
  height: number
  text: string
}

export async function validatePptxPackage(state: ValidationState): Promise<void> {
  const presentation = await readXml(state.archive, 'ppt/presentation.xml')
  requireUniqueAttributes(state, presentation, 'p:sldId', 'id', 'ppt/presentation.xml', 'slide-id')
  requireUniqueAttributes(state, presentation, 'p:sldId', 'r:id', 'ppt/presentation.xml', 'slide-relationship')
  const slideSize = /<p:sldSz\b([^>]*)\/?\s*>/i.exec(presentation)?.[1] ?? ''
  const width = numericAttribute(slideSize, 'cx')
  const height = numericAttribute(slideSize, 'cy')
  for (const entry of sortedEntries(state.archive.zip, /^ppt\/slides\/slide\d+\.xml$/i)) {
    const xml = await readXml(state.archive, entry.name)
    requireUniqueAttributes(state, xml, 'p:cNvPr', 'id', entry.name, 'shape-id')
    validateSlideLayout(state, xml, entry.name, width, height)
  }
  for (const entry of sortedEntries(state.archive.zip, /^ppt\/charts\/chart\d+\.xml$/i)) {
    validateChartAxes(state, await readXml(state.archive, entry.name), entry.name)
  }
}

function validateSlideLayout(
  state: ValidationState,
  xml: string,
  location: string,
  slideWidth: number,
  slideHeight: number,
): void {
  if (slideWidth <= 0 || slideHeight <= 0) {
    validationIssue(state, 'pptx-slide-size', 'warning', 'ppt/presentation.xml', '幻灯片尺寸无效或未声明')
    return
  }
  const objects = slideObjects(xml)
  for (const object of objects) {
    const objectLocation = `${location}#shape[${object.id}]`
    if (object.width <= 0 || object.height <= 0) {
      validationIssue(state, 'pptx-zero-size', 'warning', objectLocation, '对象宽度或高度为零')
      continue
    }
    if (
      object.x < 0 || object.y < 0
      || object.x + object.width > slideWidth * 1.01
      || object.y + object.height > slideHeight * 1.01
    ) {
      validationIssue(state, 'pptx-out-of-bounds', 'warning', objectLocation, '对象超出幻灯片边界')
    }
  }
  const textObjects = objects.filter((object) => object.text && object.width > 0 && object.height > 0)
  for (let left = 0; left < textObjects.length; left++) {
    for (let right = left + 1; right < textObjects.length; right++) {
      const first = textObjects[left]!
      const second = textObjects[right]!
      if (overlapRatio(first, second) < 0.25) continue
      validationIssue(
        state,
        'pptx-text-overlap',
        'warning',
        `${location}#shape[${first.id}]`,
        `文本对象与 shape[${second.id}] 明显重叠`,
      )
    }
  }
  let picture = 0
  for (const match of xml.matchAll(/<p:pic\b[^>]*>([\s\S]*?)<\/p:pic>/gi)) {
    picture++
    const attributes = /<p:cNvPr\b([^>]*)\/?\s*>/i.exec(match[1] ?? '')?.[1] ?? ''
    if (!attributeValue(attributes, 'descr') && !attributeValue(attributes, 'title')) {
      validationIssue(state, 'pptx-image-alt-text', 'warning', `${location}#picture[${picture}]`, '图片缺少替代文字')
    }
  }
}

function slideObjects(xml: string): SlideObject[] {
  const objects: SlideObject[] = []
  for (const match of xml.matchAll(/<p:(sp|pic|graphicFrame|cxnSp)\b[^>]*>([\s\S]*?)<\/p:\1>/gi)) {
    const body = match[2] ?? ''
    const properties = /<p:cNvPr\b([^>]*)\/?\s*>/i.exec(body)?.[1] ?? ''
    const transform = /<(?:a|p):xfrm\b[^>]*>([\s\S]*?)<\/(?:a|p):xfrm>/i.exec(body)?.[1] ?? ''
    const offset = /<a:off\b([^>]*)\/?\s*>/i.exec(transform)?.[1] ?? ''
    const extent = /<a:ext\b([^>]*)\/?\s*>/i.exec(transform)?.[1] ?? ''
    objects.push({
      id: attributeValue(properties, 'id') ?? String(objects.length + 1),
      kind: match[1] ?? 'object',
      x: numericAttribute(offset, 'x'),
      y: numericAttribute(offset, 'y'),
      width: numericAttribute(extent, 'cx'),
      height: numericAttribute(extent, 'cy'),
      text: normalizeText(elementTexts(body, 'a:t').join(' ')),
    })
  }
  return objects
}

function overlapRatio(first: SlideObject, second: SlideObject): number {
  const width = Math.max(0, Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x))
  const height = Math.max(0, Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y))
  const overlap = width * height
  return overlap / Math.min(first.width * first.height, second.width * second.height)
}

function requireUniqueAttributes(
  state: ValidationState,
  xml: string,
  tag: string,
  attribute: string,
  location: string,
  code: string,
): void {
  const values = new Set<string>()
  const expression = new RegExp(`<${tag.replace(':', '\\:')}\\b([^>]*)>`, 'gi')
  for (const match of xml.matchAll(expression)) {
    const value = attributeValue(match[1] ?? '', attribute)
    if (!value || values.has(value)) {
      validationIssue(state, code, 'error', location, `${tag} 的 ${attribute} 缺失或重复：${value ?? ''}`)
    }
    if (value) values.add(value)
  }
}

function validateChartAxes(state: ValidationState, xml: string, location: string): void {
  const definitions = new Set<string>()
  for (const match of xml.matchAll(/<c:(?:catAx|valAx|dateAx|serAx)\b[\s\S]*?<c:axId\b([^>]*)\/?\s*>/gi)) {
    const id = attributeValue(match[1] ?? '', 'val')
    if (id) definitions.add(id)
  }
  for (const match of xml.matchAll(/<c:crossAx\b([^>]*)\/?\s*>/gi)) {
    const id = attributeValue(match[1] ?? '', 'val')
    if (id && !definitions.has(id)) {
      validationIssue(state, 'chart-axis', 'error', location, `图表引用了未定义坐标轴：${id}`)
    }
  }
}

function numericAttribute(attributes: string, name: string): number {
  const value = attributeValue(attributes, name)
  return value && /^-?\d+$/.test(value) ? Number(value) : 0
}
