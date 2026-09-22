import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import JSZip from 'jszip'
import { compareOfficeTemplate } from './compare-template.ts'
import { finalizeOfficeBuild } from './finalize-build.ts'
import { inspectOfficeFile } from './inspect.ts'
import { buildOfficeFixture, officeTempDirectory } from './office-test-helpers.ts'
import { pptxSlideObjects } from './pptx-shapes.ts'
import { createPptxFromTemplate } from './template-pptx.ts'

describe('按任务声明校验 PPTX 模板', () => {
  it('允许重排普通对象、修改替代文字和共享样式，不把包字节一致当成设计要求', async () => {
    const { root, template, zip } = await fixture()
    const slide = await zip.file('ppt/slides/slide1.xml')!.async('string')
    const objects = pptxSlideObjects(slide)
    const body = objects[1]!
    const changedBody = body.xml.replace(/x="\d+"/u, 'x="2000000"')
      .replace(/name="[^"]*"/u, 'name="重新排版" descr="新的替代文字"')
    assert.notEqual(changedBody, body.xml)
    zip.file('ppt/slides/slide1.xml', slide.replace(body.xml, changedBody))
    const theme = await zip.file('ppt/theme/theme1.xml')!.async('string')
    const changedTheme = theme.replace(/name="[^"]*"/u, 'name="任务主题"')
    assert.notEqual(changedTheme, theme)
    zip.file('ppt/theme/theme1.xml', changedTheme)
    const output = await save(zip, root)
    const comparison = await compareOfficeTemplate({
      templatePath: template, outputPath: output, format: 'pptx',
      pptxTemplateRequirements: {
        requireExactDimensions: true, referenceSlides: [1], minimumCoverageRatio: 0.5,
        requirePlaceholderGeometry: true,
      },
    })
    assert.equal(comparison.protectedPartCount, 0)
    assert.equal(comparison.checks.length, 3)
    assert.match(comparison.checks.join('\n'), /1\/2 页/)
  })

  it('画幅默认可修改，显式要求保留时拒绝并且不写入最终目标', async () => {
    const { root, template, zip } = await fixture()
    const presentation = await zip.file('ppt/presentation.xml')!.async('string')
    zip.file('ppt/presentation.xml', presentation.replace(/(<p:sldSz\b[^>]*\bcx=")\d+/u, '$110000000'))
    const output = await save(zip, root)
    assert.deepEqual((await compareOfficeTemplate({
      templatePath: template, outputPath: output, format: 'pptx',
    })).checks, [])
    const target = join(root, 'existing.pptx')
    await writeFile(target, '原文件不得改变')
    await assert.rejects(finalizeOfficeBuild({
      format: 'pptx', stagedPath: output, targetPath: target, templatePath: template,
      pptxTemplateRequirements: { requireExactDimensions: true },
      workingDirectory: root, recalculatedPath: '',
      inspection: await inspectOfficeFile(output, { startUnit: 1, unitCount: 20, view: 'content' }),
      abortSignal: new AbortController().signal,
    }, {
      compareTemplate: compareOfficeTemplate,
      async recalculate() { throw new Error('不应重算') },
      async inspect() { throw new Error('不应重检') },
      async publish() { throw new Error('不应发布') },
    }), /页面尺寸与源模板不同/u)
    assert.equal(await readFile(target, 'utf8'), '原文件不得改变')
  })

  it('占位符位置仅在声明时检查，错误指出输出页；覆盖率只用声明的比例', async () => {
    const { root, template, zip } = await fixture()
    const slide = await zip.file('ppt/slides/slide1.xml')!.async('string')
    const title = pptxSlideObjects(slide)[0]!
    const moved = title.xml.replace(/(<a:off\b[^>]*\bx=")\d+/u, (_match, prefix: string) => `${prefix}2000000`)
    assert.notEqual(moved, title.xml)
    zip.file('ppt/slides/slide1.xml', slide.replace(title.xml, moved))
    const output = await save(zip, root)
    const options = { templatePath: template, outputPath: output, format: 'pptx' as const }
    await compareOfficeTemplate(options)
    await compareOfficeTemplate({ ...options, pptxTemplateRequirements: {
      referenceSlides: [1], minimumCoverageRatio: 0.5,
    } })
    await assert.rejects(compareOfficeTemplate({ ...options, pptxTemplateRequirements: {
      referenceSlides: [1], minimumCoverageRatio: 0.5, requirePlaceholderGeometry: true,
    } }), /输出第 1 页.*占位符位置或尺寸/u)
    await assert.rejects(compareOfficeTemplate({ ...options, pptxTemplateRequirements: {
      referenceSlides: [1], minimumCoverageRatio: 1,
    } }), /覆盖 1\/2 页.*100%/u)
    await assert.rejects(compareOfficeTemplate({ ...options, pptxTemplateRequirements: {
      referenceSlides: [3], minimumCoverageRatio: 1,
    } }), /参考页 3 不存在/u)
    await assert.rejects(compareOfficeTemplate({ ...options, pptxTemplateRequirements: {
      referenceSlides: [2], minimumCoverageRatio: 1, requirePlaceholderGeometry: true,
    } }), /参考页 2 没有占位符/u)
  })

  it('解析继承的占位符几何，母版或版式变化不能绕过明确的约束', async () => {
    const { root, template, zip } = await fixture()
    const slide = await zip.file('ppt/slides/slide1.xml')!.async('string')
    const title = pptxSlideObjects(slide)[0]!
    const inherited = title.xml.replace(/<a:xfrm\b[^>]*>[\s\S]*?<\/a:xfrm>/u, '')
    zip.file('ppt/slides/slide1.xml', slide.replace(title.xml, inherited))
    const layoutPath = 'ppt/slideLayouts/slideLayout1.xml'
    const layout = await zip.file(layoutPath)!.async('string')
    zip.file(layoutPath, layout.replace('</p:spTree>', `${title.xml}</p:spTree>`))
    await save(zip, root, 'template.pptx')
    const options = {
      templatePath: template, format: 'pptx' as const,
      pptxTemplateRequirements: { referenceSlides: [1], minimumCoverageRatio: 1, requirePlaceholderGeometry: true },
    }
    await compareOfficeTemplate({ ...options, outputPath: template })
    const changedLayout = await zip.file(layoutPath)!.async('string')
    const moved = title.xml.replace(/(<a:off\b[^>]*\bx=")\d+/u, (_match, prefix: string) => `${prefix}3000000`)
    assert.notEqual(moved, title.xml)
    zip.file(layoutPath, changedLayout.replace(title.xml, moved))
    await assert.rejects(compareOfficeTemplate({ ...options, outputPath: await save(zip, root) }), /占位符位置或尺寸/u)
  })

  it('删除普通文字无需媒体理由，错误目标指出页面和对象', async () => {
    const { root, template, zip } = await fixture()
    const source = await zip.file('ppt/slides/slide1.xml')!.async('string')
    const shapeId = pptxSlideObjects(source)[1]!.shapeId
    const output = join(root, 'deleted-text.pptx')
    await writeFile(output, await createPptxFromTemplate({
      template: await readFile(template), slides: [{ sourceSlide: 1, edits: [{ shapeId, delete: true }] }],
    }))
    const inspection = await inspectOfficeFile(output, { startUnit: 1, unitCount: 20, view: 'content' })
    assert.doesNotMatch(inspection.units.map((unit) => unit.text).join('\n'), /普通正文/u)
    await assert.rejects(createPptxFromTemplate({
      template: await readFile(template), slides: [{ sourceSlide: 1, edits: [{ shapeId: 999, delete: true }] }],
    }), /输出第 1 页（源页 1）.*不存在 shape\[999\]/u)
  })

  it('即使未声明模板约束，也拒绝损坏的 XML', async () => {
    const { root, template, zip } = await fixture()
    zip.file('ppt/slides/slide1.xml', '<p:sld>损坏')
    await assert.rejects(compareOfficeTemplate({
      templatePath: template, outputPath: await save(zip, root), format: 'pptx',
    }), /OOXML 部件格式无效/u)
  })
})

async function fixture() {
  const root = await officeTempDirectory()
  const template = join(root, 'template.pptx')
  await buildOfficeFixture(root, template, 'pptx', `({ PptxGenJS }) => {
    const deck = new PptxGenJS()
    deck.layout = 'LAYOUT_WIDE'
    const first = deck.addSlide()
    first.addText('占位标题', { x: 1, y: 1, w: 8, h: 1 })
    first.addText('普通正文', { x: 1, y: 3, w: 8, h: 1 })
    deck.addSlide().addText('第二页', { x: 1, y: 1, w: 8, h: 1 })
    return deck
  }`)
  const zip = await JSZip.loadAsync(await readFile(template))
  const first = await zip.file('ppt/slides/slide1.xml')!.async('string')
  const title = pptxSlideObjects(first)[0]!
  const placeholder = title.xml.replace(/<p:nvPr\s*\/>|<p:nvPr>\s*<\/p:nvPr>/u,
    '<p:nvPr><p:ph type="title" idx="0"/></p:nvPr>')
  assert.notEqual(placeholder, title.xml)
  zip.file('ppt/slides/slide1.xml', first.replace(title.xml, placeholder))
  await save(zip, root, 'template.pptx')
  return { root, template, zip }
}

async function save(zip: JSZip, root: string, name = 'output.pptx'): Promise<string> {
  const path = join(root, name)
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }))
  return path
}
