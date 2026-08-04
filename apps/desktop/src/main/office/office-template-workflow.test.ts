import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import JSZip from 'jszip'
import { buildOfficeFile } from './build-engine.ts'
import { compareOfficeTemplate } from './compare-template.ts'
import { inspectOfficeFile } from './inspect.ts'
import { applySlideEdits } from './template-pptx-edits.ts'
import {
  buildOfficeFixture as build,
  officeTempDirectory as tempDirectory,
} from './office-test-helpers.ts'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2hAAAAABJRU5ErkJggg==',
  'base64',
)
const REPLACEMENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8zwAAAgEBAScY42sAAAAASUVORK5CYII=',
  'base64',
)

describe('Office 模板工作流', () => {
  it('DOCX 使用物理段落 locator 原位替换并保留模板结构', async () => {
    const root = await tempDirectory()
    const template = join(root, 'template.docx')
    await build(root, template, 'docx', `({ docx }) => new docx.Document({
      styles: { paragraphStyles: [{
        id: 'TemplateBody', name: 'Template Body', basedOn: 'Normal', next: 'TemplateBody',
        run: { font: 'Microsoft YaHei', size: 24, color: '234567' },
        paragraph: { spacing: { after: 160, line: 360 } },
      }] },
      sections: [{
        headers: { default: new docx.Header({ children: [new docx.Paragraph('Template header')] }) },
        children: [
          new docx.Paragraph(''),
          new docx.Paragraph({ text: 'Template title', style: 'TemplateBody' }),
          new docx.Table({ rows: [new docx.TableRow({ children: [
            new docx.TableCell({ children: [new docx.Paragraph('Evaluation table')] }),
          ] })] }),
          new docx.Paragraph({ text: 'Body style source', style: 'TemplateBody' }),
          new docx.Paragraph({ text: 'Replace range start', style: 'TemplateBody' }),
          new docx.Paragraph({ text: 'Replace range end', style: 'TemplateBody' }),
        ],
      }],
    })`)

    const content = await inspectOfficeFile(template, {
      startUnit: 1, unitCount: 20, view: 'content',
    })
    const templateView = await inspectOfficeFile(template, {
      startUnit: 1, unitCount: 50, view: 'template',
    })
    const styles = await inspectOfficeFile(template, {
      startUnit: 1, unitCount: 50, view: 'styles',
    })
    const title = unitContaining(templateView, 'Template title')
    const source = unitContaining(templateView, 'Body style source')
    const rangeStart = unitContaining(templateView, 'Replace range start')
    const rangeEnd = unitContaining(templateView, 'Replace range end')
    assert.equal(unitContaining(content, 'Template title').locator, title.locator)
    assert.equal(title.locator, 'word/document.xml#paragraph[2]')
    assert.match(title.text, /样式：TemplateBody/)
    const templateBodyStyle = unitContaining(styles, 'ID：TemplateBody')
    assert.match(templateBodyStyle.text, /间距 前 继承 \/ 后 160 \/ 行 360/)
    assert.match(templateBodyStyle.text, /字体 Microsoft YaHei；字号 24 half-point；颜色 234567/)

    const script = join(root, 'docx-template-builder.js')
    const output = join(root, 'template-output.docx')
    await writeFile(script, `async ({ OfficeTemplate, assets }) => OfficeTemplate.docx({
      template: assets.template.bytes,
      textEdits: [{ locator: ${JSON.stringify(title.locator)}, text: 'Inherited title' }],
      rangeEdits: [{
        startLocator: ${JSON.stringify(rangeStart.locator)},
        endLocator: ${JSON.stringify(rangeEnd.locator)},
        blocks: [
          { sourceLocator: ${JSON.stringify(source.locator)}, text: 'First inherited paragraph', pageBreakBefore: true },
          { sourceLocator: ${JSON.stringify(source.locator)}, text: 'Second inherited paragraph' },
        ],
      }],
    })`, 'utf8')
    const result = await buildOfficeFile({
      format: 'docx', scriptPath: script, outputPath: output,
      assets: [{ key: 'template', path: template }],
    })

    assert.match(result.inspection.units.map((unit) => unit.text).join('\n'), /Inherited title/)
    assert.match(result.inspection.units.map((unit) => unit.text).join('\n'), /First inherited paragraph/)
    assert.doesNotMatch(result.inspection.units.map((unit) => unit.text).join('\n'), /Replace range start/)
    const comparison = await compareOfficeTemplate({
      templatePath: template, outputPath: output, format: 'docx',
    })
    assert.equal(comparison.removedPartCount, 0)
    assert.equal(comparison.modifiedProtectedParts.length, 0)
    const [before, after] = await Promise.all([
      JSZip.loadAsync(await readFile(template)),
      JSZip.loadAsync(await readFile(output)),
    ])
    assert.deepEqual(
      await before.file('word/styles.xml')!.async('uint8array'),
      await after.file('word/styles.xml')!.async('uint8array'),
    )

    const withoutTable = await JSZip.loadAsync(await readFile(output))
    const document = await withoutTable.file('word/document.xml')!.async('string')
    withoutTable.file('word/document.xml', document.replace(/<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>/iu, ''))
    const damaged = join(root, 'missing-template-table.docx')
    await writeFile(damaged, await withoutTable.generateAsync({ type: 'nodebuffer' }))
    await assert.rejects(() => compareOfficeTemplate({
      templatePath: template, outputPath: damaged, format: 'docx',
    }), /表格结构/)
  })

  it('PPTX 复制源页、复用版式和备注，并拒绝空白重建冒充模板', async () => {
    const root = await tempDirectory()
    const template = join(root, 'template.pptx')
    await build(root, template, 'pptx', `({ PptxGenJS }) => {
      const deck = new PptxGenJS()
      deck.layout = 'LAYOUT_WIDE'
      deck.defineSlideMaster({
        title: 'WHYCODE_MASTER',
        background: { color: 'F3F6FA' },
        objects: [
          { rect: { x: 0, y: 0, w: 13.333, h: 0.18, fill: { color: '164A7B' }, line: { color: '164A7B' } } },
          { text: { text: 'WHYCODE', options: { x: 10.8, y: 7.05, w: 1.8, h: 0.25, fontSize: 8, color: '164A7B' } } },
        ],
        slideNumber: { x: 12.55, y: 7.05, w: 0.4, h: 0.25, fontSize: 8, color: '164A7B' },
      })
      const cover = deck.addSlide('WHYCODE_MASTER')
      cover.addText('Template cover', { x: 1, y: 1.2, w: 9, h: 0.7, fontSize: 30, bold: true, color: '164A7B' })
      cover.addNotes('Template cover notes')
      const body = deck.addSlide('WHYCODE_MASTER')
      body.addText('Template body title', { x: 0.8, y: 0.7, w: 10.5, h: 0.5, fontSize: 24, bold: true, color: '164A7B' })
      body.addText('Template body text', { x: 0.9, y: 1.6, w: 10.8, h: 3.8, fontSize: 18, color: '263238' })
      body.addImage({ data: 'data:image/png;base64,${ONE_PIXEL_PNG.toString('base64')}', x: 11.5, y: 1.6, w: 1, h: 1 })
      body.addNotes('Template body notes')
      return deck
    }`)

    const templateView = await inspectOfficeFile(template, {
      startUnit: 1, unitCount: 20, view: 'template',
    })
    assert.equal(templateView.units.length, 2)
    assert.ok(templateView.units.every((unit) => unit.kind === 'template-slide'))
    assert.ok(templateView.units.every((unit) => /版式：ppt\/slideLayouts\//.test(unit.text)))
    assert.match(unitContaining(templateView, 'Template cover').text, /字号 30pt/)
    assert.match(templateView.units[1]!.text, /类型 pic；占位符 否；.*资源 rId\d+/u)
    assert.match(templateView.units[1]!.text, /target ppt\/media\/image[^/]*\.png/u)
    assert.match(templateView.units[1]!.text, /SHA-256 [a-f0-9]{64}/u)
    assert.match(templateView.units[1]!.text, /active uses 1/u)
    const coverShape = shapeId(unitContaining(templateView, 'Template cover').text, 'Template cover')
    const bodyTitleShape = shapeId(
      unitContaining(templateView, 'Template body title').text,
      'Template body title',
    )
    const bodyTextShape = shapeId(
      unitContaining(templateView, 'Template body text').text,
      'Template body text',
    )
    const bodyObjects = await inspectOfficeFile(template, {
      startUnit: 1, unitCount: 50, view: 'objects', slideNumber: 2,
    })
    const imageObject = bodyObjects.units.find((unit) => unit.kind === 'image')
    assert.ok(imageObject)
    const imageShape = Number(/#shape\[(\d+)\]$/u.exec(imageObject.locator)?.[1])
    assert.ok(Number.isSafeInteger(imageShape) && imageShape > 0)

    const script = join(root, 'pptx-template-builder.js')
    const output = join(root, 'template-output.pptx')
    const replacement = join(root, 'replacement.png')
    await writeFile(replacement, REPLACEMENT_PNG)
    await writeFile(script, `async ({ OfficeTemplate, assets }) => OfficeTemplate.pptx({
      template: assets.template.bytes,
      slides: [
        { sourceSlide: 1, edits: [{ shapeId: ${coverShape}, text: 'Inherited cover' }] },
        { sourceSlide: 2, edits: [
          { shapeId: ${bodyTitleShape}, text: 'Inherited body title' },
          { shapeId: ${bodyTextShape}, paragraphs: ['First point', 'Second point'] },
          { shapeId: ${imageShape}, image: { bytes: assets.figure.bytes, extension: assets.figure.extension }, mediaRole: 'content', reason: 'replace source-specific result figure' },
        ] },
        { sourceSlide: 2, edits: [
          { shapeId: ${bodyTitleShape}, text: 'Repeated source page' },
          { shapeId: ${bodyTextShape}, text: 'Independent clone' },
          { shapeId: ${imageShape}, keep: true, mediaRole: 'decoration', reason: 'fixture image is reusable decoration' },
        ] },
        { sourceSlide: 2, edits: [
          { shapeId: ${bodyTitleShape}, text: 'Content-only source page' },
          { shapeId: ${bodyTextShape}, text: 'Source-specific visual removed' },
          { shapeId: ${imageShape}, delete: true, mediaRole: 'content', reason: 'no matching target-topic visual' },
        ] },
      ],
    })`, 'utf8')
    const result = await buildOfficeFile({
      format: 'pptx', scriptPath: script, outputPath: output,
      assets: [
        { key: 'template', path: template },
        { key: 'figure', path: replacement },
      ],
    })

    assert.equal(result.inspection.unitCount, 4)
    assert.deepEqual(
      result.inspection.units.map((unit) => unit.text),
      [
        'Inherited cover | 1',
        'Inherited body title | First point | Second point | 2',
        'Repeated source page | Independent clone | 3',
        'Content-only source page | Source-specific visual removed | 4',
      ],
    )
    const notes = await inspectOfficeFile(output, {
      startUnit: 1, unitCount: 50, view: 'objects',
    })
    assert.equal(notes.units.filter((unit) => unit.kind === 'notes').length, 4)
    const deletedMediaObjects = await inspectOfficeFile(output, {
      startUnit: 1, unitCount: 50, view: 'objects', slideNumber: 4,
    })
    assert.equal(deletedMediaObjects.units.filter((unit) => unit.kind === 'image').length, 0)
    const replacedMediaObjects = await inspectOfficeFile(output, {
      startUnit: 1, unitCount: 50, view: 'objects', slideNumber: 2,
    })
    const replacedImage = replacedMediaObjects.units.find((unit) => unit.kind === 'image')
    assert.ok(replacedImage)
    assert.match(replacedImage.text, /target ppt\/media\/whycode-\d+-\d+\.png/u)
    assert.match(
      replacedImage.text,
      new RegExp(createHash('sha256').update(REPLACEMENT_PNG).digest('hex'), 'u'),
    )
    const comparison = await compareOfficeTemplate({
      templatePath: template, outputPath: output, format: 'pptx',
    })
    assert.equal(comparison.modifiedProtectedParts.length, 0)
    const outputZip = await JSZip.loadAsync(await readFile(output))
    assert.ok(Object.keys(outputZip.files).some((path) =>
      /^ppt\/media\/whycode-\d+-\d+\.png$/u.test(path)))

    const missingMediaScript = join(root, 'missing-media-decision.js')
    await writeFile(missingMediaScript, `async ({ OfficeTemplate, assets }) => OfficeTemplate.pptx({
      template: assets.template.bytes,
      slides: [{ sourceSlide: 2, edits: [
        { shapeId: ${bodyTitleShape}, text: 'Missing media decision' },
      ] }],
    })`, 'utf8')
    await assert.rejects(() => buildOfficeFile({
      format: 'pptx', scriptPath: missingMediaScript, outputPath: join(root, 'missing-media.pptx'),
      assets: [{ key: 'template', path: template }],
    }), /媒体 shape\[\d+\] 必须由一个 keep、image 或 delete 动作明确处置/u)

    const invalidKeepScript = join(root, 'invalid-content-keep.js')
    await writeFile(invalidKeepScript, `async ({ OfficeTemplate, assets }) => OfficeTemplate.pptx({
      template: assets.template.bytes,
      slides: [{ sourceSlide: 2, edits: [
        { shapeId: ${imageShape}, keep: true, mediaRole: 'content', reason: 'invalid fixture' },
      ] }],
    })`, 'utf8')
    await assert.rejects(() => buildOfficeFile({
      format: 'pptx', scriptPath: invalidKeepScript, outputPath: join(root, 'invalid-keep.pptx'),
      assets: [{ key: 'template', path: template }],
    }), /keep 只适用于 brand 或 decoration 媒体/u)

    const rebuilt = join(root, 'blank-rebuild.pptx')
    await build(root, rebuilt, 'pptx', `({ PptxGenJS }) => {
      const deck = new PptxGenJS()
      deck.layout = 'LAYOUT_WIDE'
      deck.addSlide().addText('Inherited cover', { x: 1, y: 1.2, w: 9, h: 0.7 })
      return deck
    }`)
    await assert.rejects(() => compareOfficeTemplate({
      templatePath: template, outputPath: rebuilt, format: 'pptx',
    }), /共享版式或媒体部件|没有沿用模板版式|不是从模板源页复制/)
  })

  it('PPTX 媒体处置可按 group 原子删除成员与关系', () => {
    const xml = '<p:sld><p:cSld><p:spTree>'
      + '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="10" name="Content group"/></p:nvGrpSpPr>'
      + '<p:grpSpPr><a:xfrm><a:off x="1" y="2"/><a:ext cx="3" cy="4"/></a:xfrm></p:grpSpPr>'
      + '<p:pic><p:nvPicPr><p:cNvPr id="11" name="Source figure"/></p:nvPicPr>'
      + '<p:blipFill><a:blip r:embed="rId5"/></p:blipFill></p:pic>'
      + '<p:sp><p:nvSpPr><p:cNvPr id="12" name="Caption"/></p:nvSpPr>'
      + '<p:txBody><a:p><a:r><a:t>Source caption</a:t></a:r></a:p></p:txBody></p:sp>'
      + '</p:grpSp></p:spTree></p:cSld></p:sld>'
    const result = applySlideEdits(xml, [{
      shapeId: '10', delete: true, mediaRole: 'content', reason: 'remove source-topic group',
    }])

    assert.doesNotMatch(result.xml, /Content group|Source figure|Source caption/u)
    assert.deepEqual([...result.removedRelationshipIds], ['rId5'])
  })
})

function unitContaining(
  inspection: Awaited<ReturnType<typeof inspectOfficeFile>>,
  value: string,
) {
  const unit = inspection.units.find((candidate) => candidate.text.includes(value))
  assert.ok(unit, `找不到包含 ${value} 的检查单元`)
  return unit
}

function shapeId(templateUnitText: string, value: string): number {
  const line = templateUnitText.split('\n').find((candidate) => candidate.includes(value))
  const id = line ? /shape\[(\d+)\]/u.exec(line)?.[1] : undefined
  assert.ok(id, `找不到 ${value} 的 shape ID`)
  return Number(id)
}
