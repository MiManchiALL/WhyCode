import {
  OfficeProcessingError,
  pptxTemplateRequirementsSchema,
  type PptxTemplateRequirements,
} from '@whycode/core/office'
import { readXml, type OfficeArchive } from './archive.ts'
import { orderedSlidePaths } from './inspect-pptx-views.ts'
import { pptxSlideObjects } from './pptx-shapes.ts'
import { readRelationships, relationshipTarget } from './relationships.ts'
import { relationshipPath } from './template-pptx-package.ts'
import { attributeValue } from './xml.ts'

type Geometry = readonly number[] | null
type Placeholders = Map<string, Geometry>
interface SlideProfile {
  family: string
  placeholders: Placeholders
}

export async function comparePptxTemplate(
  template: OfficeArchive,
  output: OfficeArchive,
  requirements: PptxTemplateRequirements | undefined,
): Promise<string[]> {
  if (!requirements) return []
  const policy = pptxTemplateRequirementsSchema.parse(requirements)
  const checks: string[] = []
  const [sourceXml, outputXml] = await Promise.all([
    readXml(template, 'ppt/presentation.xml'), readXml(output, 'ppt/presentation.xml'),
  ])
  if (policy.requireExactDimensions) {
    if (slideSize(sourceXml) !== slideSize(outputXml)) {
      throw new OfficeProcessingError('corrupted', 'PPTX 模板要求未满足：页面尺寸与源模板不同')
    }
    checks.push('页面尺寸与源模板一致')
  }
  if (!policy.referenceSlides) return checks
  const [sourcePaths, outputPaths] = await Promise.all([
    orderedSlidePaths(template, sourceXml), orderedSlidePaths(output, outputXml),
  ])
  const references: SlideProfile[] = []
  for (const number of policy.referenceSlides) {
    const path = sourcePaths[number - 1]
    if (!path) throw new OfficeProcessingError('invalid-range', `PPTX 模板参考页 ${number} 不存在`)
    const profile = await slideProfile(template, path)
    if (policy.requirePlaceholderGeometry && profile.placeholders.size === 0) {
      throw new OfficeProcessingError('invalid-range', `PPTX 模板参考页 ${number} 没有占位符，不能据此验证占位符位置`)
    }
    if (policy.requirePlaceholderGeometry && [...profile.placeholders.values()].some((value) => !value)) {
      throw new OfficeProcessingError('invalid-range', `PPTX 模板参考页 ${number} 存在无法确定位置的占位符`)
    }
    references.push(profile)
  }
  let matched = 0
  for (const [index, path] of outputPaths.entries()) {
    const profile = await slideProfile(output, path)
    const candidates = references.filter((source) => source.family === profile.family)
    if (!candidates.length) continue
    if (policy.requirePlaceholderGeometry
      && !candidates.some((source) => sameGeometry(source.placeholders, profile.placeholders))) {
      throw new OfficeProcessingError('corrupted', `PPTX 模板要求未满足：输出第 ${index + 1} 页（${path}）的占位符位置或尺寸与参考页不同`)
    }
    matched++
  }
  const ratio = outputPaths.length ? matched / outputPaths.length : 0
  if (!outputPaths.length || ratio < policy.minimumCoverageRatio!) {
    throw new OfficeProcessingError('corrupted', `PPTX 模板要求未满足：参考版式覆盖 ${matched}/${outputPaths.length} 页，低于要求的 ${policy.minimumCoverageRatio! * 100}%`)
  }
  checks.push(`参考版式覆盖 ${matched}/${outputPaths.length} 页，达到要求的 ${policy.minimumCoverageRatio! * 100}%`)
  if (policy.requirePlaceholderGeometry) checks.push('匹配参考版式的页面保留占位符位置和尺寸')
  return checks
}

async function slideProfile(archive: OfficeArchive, path: string): Promise<SlideProfile> {
  const slide = await readXml(archive, path)
  const layoutPath = await relatedPart(archive, path, '/slideLayout')
  const layout = await readXml(archive, layoutPath)
  const master = await readXml(archive, await relatedPart(archive, layoutPath, '/slideMaster'))
  const layers = [placeholderMap(slide), placeholderMap(layout), placeholderMap(master)]
  const identities = new Set([...layers[0]!.keys(), ...layers[1]!.keys()])
  if (!identities.size) layers[2]!.forEach((_value, key) => identities.add(key))
  const placeholders: Placeholders = new Map()
  for (const key of [...identities].sort()) {
    placeholders.set(key, inheritedGeometry(key, layers))
  }
  return {
    family: JSON.stringify([
      attributeValue(/<p:sldLayout\b([^>]*)/u.exec(layout)?.[1] ?? '', 'type') ?? 'custom',
      [...placeholders.keys()], [...layers[2]!.keys()].sort(),
    ]),
    placeholders,
  }
}

async function relatedPart(archive: OfficeArchive, path: string, type: string): Promise<string> {
  const relsPath = relationshipPath(path)
  const matches = (await readRelationships(archive, relsPath))
    .filter((item) => !item.external && item.type.endsWith(type))
  if (matches.length !== 1) {
    throw new OfficeProcessingError('corrupted', `PPTX ${path} 必须有唯一的 ${type} 关系`)
  }
  return relationshipTarget(relsPath, matches[0]!.target)
}

function placeholderMap(xml: string): Placeholders {
  const result: Placeholders = new Map()
  for (const object of pptxSlideObjects(xml).filter((entry) => entry.tag !== 'grpSp')) {
    const placeholder = /<p:ph\b([^>]*)/u.exec(object.xml)
    if (!placeholder) continue
    const key = JSON.stringify([
      attributeValue(placeholder[1]!, 'type') ?? 'obj', attributeValue(placeholder[1]!, 'idx') ?? '',
    ])
    if (result.has(key)) throw new OfficeProcessingError('corrupted', `PPTX 占位符身份重复：${key}`)
    const transform = /<(?:a|p):xfrm\b[^>]*>([\s\S]*?)<\/(?:a|p):xfrm>/u.exec(object.xml)?.[1]
    const offset = /<a:off\b([^>]*)/u.exec(transform ?? '')?.[1]
    const extent = /<a:ext\b([^>]*)/u.exec(transform ?? '')?.[1]
    const values = offset && extent ? [
      attributeValue(offset, 'x'), attributeValue(offset, 'y'),
      attributeValue(extent, 'cx'), attributeValue(extent, 'cy'),
    ] : []
    if (values.some((value) => value !== null && !Number.isSafeInteger(Number(value)))) {
      throw new OfficeProcessingError('corrupted', `PPTX 占位符坐标无效：shape[${object.shapeId}]`)
    }
    result.set(key, values.length && values.every((value) => value !== null) ? values.map(Number) : null)
  }
  return result
}

function inheritedGeometry(key: string, layers: Placeholders[]): Geometry {
  const [kind] = JSON.parse(key) as string[]
  for (const layer of layers) {
    const exact = layer.get(key)
    if (exact) return exact
    const sameKind = [...layer].filter(([identity, value]) => value && (JSON.parse(identity) as string[])[0] === kind)
    if (sameKind.length === 1) return sameKind[0]![1]
  }
  return null
}

function sameGeometry(source: Placeholders, output: Placeholders): boolean {
  return source.size === output.size && [...source].every(([key, value]) =>
    output.has(key) && JSON.stringify(value) === JSON.stringify(output.get(key)))
}

function slideSize(xml: string): string {
  const attributes = /<p:sldSz\b([^>]*)/u.exec(xml)?.[1] ?? ''
  const width = Number(attributeValue(attributes, 'cx'))
  const height = Number(attributeValue(attributes, 'cy'))
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new OfficeProcessingError('corrupted', 'PPTX 页面尺寸无效')
  }
  return `${width},${height}`
}
