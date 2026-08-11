import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import JSZip from 'jszip'
import { buildOfficeFile } from './build-engine.ts'
import { compareOfficeTemplate } from './compare-template.ts'
import { finalizeOfficeBuild } from './finalize-build.ts'
import { inspectOfficeFile } from './inspect.ts'
import { buildOfficeFixture as build, officeTempDirectory as tempDirectory } from './office-test-helpers.ts'

describe('Office OOXML engine advanced', () => {
  it('最终发布编排只接受真实重算后的公式与最终哈希', async () => {
    const root = await tempDirectory()
    const output = join(root, 'final.xlsx')
    const initial = await build(root, join(root, 'initial.xlsx'), 'xlsx', `async ({ ExcelJS }) => {
      const workbook = new ExcelJS.Workbook()
      const sheet = workbook.addWorksheet('Calc')
      sheet.getCell('A1').value = { formula: '1+1', result: 2 }
      return workbook
    }`)
    const finalInspection = {
      ...initial.inspection,
      sha256: 'c'.repeat(64),
      formulaUncalculatedCount: 0,
      formulaErrorCount: 0,
    }
    const progress: string[] = []
    let published: { source: string; target: string; sha256: string } | undefined
    const result = await finalizeOfficeBuild({
      format: 'xlsx',
      stagedPath: 'staged.xlsx',
      recalculatedPath: 'recalculated.xlsx',
      targetPath: output,
      templatePath: 'template.xlsx',
      workingDirectory: root,
      inspection: { ...initial.inspection, formulaUncalculatedCount: 1 },
      abortSignal: new AbortController().signal,
      onProgress: (line) => progress.push(line),
    }, {
      async recalculate() { return 'microsoft-excel' },
      async inspect() { return finalInspection },
      async compareTemplate() {
        return {
          templateSha256: 'b'.repeat(64), templatePartCount: 10, outputPartCount: 11,
          addedPartCount: 1, removedPartCount: 0, protectedPartCount: 4,
          modifiedProtectedParts: [],
        }
      },
      async publish(source, target, sha256) { published = { source, target, sha256 } },
    })
    assert.deepEqual(result.recalculation, { engine: 'microsoft-excel', formulaCount: 1 })
    assert.equal(result.template?.protectedPartCount, 4)
    assert.deepEqual(published, {
      source: 'recalculated.xlsx', target: output, sha256: 'c'.repeat(64),
    })
    assert.equal(progress.length, 2)

    await assert.rejects(() => finalizeOfficeBuild({
      format: 'xlsx', stagedPath: 'staged.xlsx', recalculatedPath: 'bad.xlsx',
      targetPath: output, workingDirectory: root, inspection: initial.inspection,
      abortSignal: new AbortController().signal,
    }, {
      async recalculate() { return 'libreoffice' },
      async inspect() { return { ...finalInspection, formulaErrorCount: 1 } },
      async compareTemplate() { throw new Error('unexpected') },
      async publish() { throw new Error('unexpected') },
    }), /公式错误值/)

    let externalLinkRecalculationCalled = false
    await assert.rejects(() => finalizeOfficeBuild({
      format: 'xlsx', stagedPath: 'external.xlsx', recalculatedPath: 'external-final.xlsx',
      targetPath: output, workingDirectory: root,
      inspection: {
        ...initial.inspection,
        validation: {
          ...initial.inspection.validation,
          issues: [{
            code: 'xlsx-external-workbook', severity: 'warning',
            location: 'xl/externalLinks/externalLink1.xml', message: 'external',
          }],
        },
      },
      abortSignal: new AbortController().signal,
    }, {
      async recalculate() { externalLinkRecalculationCalled = true; return 'microsoft-excel' },
      async inspect() { throw new Error('unexpected') },
      async compareTemplate() { throw new Error('unexpected') },
      async publish() { throw new Error('unexpected') },
    }), /外部工作簿/)
    assert.equal(externalLinkRecalculationCalled, false)
  })

  it('公式追踪把共享公式按目标单元格平移', async () => {
    const root = await tempDirectory()
    const output = join(root, 'shared-formula.xlsx')
    await build(root, output, 'xlsx', `async ({ ExcelJS }) => {
      const workbook = new ExcelJS.Workbook()
      const sheet = workbook.addWorksheet('Calc')
      const source = workbook.addWorksheet('A1')
      source.getCell('A1').value = 10
      sheet.getCell('A2').value = 2
      sheet.getCell('A3').value = 3
      sheet.fillFormula('B2:B3', 'A2*2', [4, 6])
      sheet.fillFormula('E2:E3', "'A1'!$A$1+A2", [12, 13])
      workbook.definedNames.add('Calc!$A$3', 'InputValue')
      sheet.getCell('C3').value = { formula: 'InputValue*2', result: 6 }
      sheet.getCell('D3').value = { formula: 'LOG10(A3)', result: 0.4771212547 }
      return workbook
    }`)
    const trace = await inspectOfficeFile(output, {
      startUnit: 1, unitCount: 20, view: 'formula-trace', sheetName: 'Calc', range: 'B3',
    })
    assert.match(trace.units[0]?.text ?? '', /公式：A3\*2/)
    assert.ok(trace.units.some((unit) => unit.label === 'Calc!A3'))
    assert.ok(trace.units.every((unit) => unit.label !== 'Calc!A2'))
    const namedTrace = await inspectOfficeFile(output, {
      startUnit: 1, unitCount: 20, view: 'formula-trace', sheetName: 'Calc', range: 'C3',
    })
    assert.ok(namedTrace.units.some((unit) => unit.label === 'Calc!A3'))
    const functionTrace = await inspectOfficeFile(output, {
      startUnit: 1, unitCount: 20, view: 'formula-trace', sheetName: 'Calc', range: 'D3',
    })
    assert.match(functionTrace.units[0]?.text ?? '', /Calc!A3/)
    assert.doesNotMatch(functionTrace.units[0]?.text ?? '', /Calc!LOG10/)
    const quotedSheetTrace = await inspectOfficeFile(output, {
      startUnit: 1, unitCount: 20, view: 'formula-trace', sheetName: 'Calc', range: 'E3',
    })
    assert.match(quotedSheetTrace.units[0]?.text ?? '', /公式：'A1'!\$A\$1\+A3/)
    assert.ok(quotedSheetTrace.units.some((unit) => unit.label === 'A1!A1'))
    const objects = await inspectOfficeFile(output, {
      startUnit: 1, unitCount: 50, view: 'objects', sheetName: 'Calc',
    })
    assert.ok(objects.units.some((unit) => unit.kind === 'defined-name'
      && /InputValue/.test(unit.label)))
  })

  it('PPTX 确定性版式检查报告越界和明显文本重叠', async () => {
    const root = await tempDirectory()
    const output = join(root, 'layout.pptx')
    const result = await build(root, output, 'pptx', `async ({ PptxGenJS }) => {
      const deck = new PptxGenJS()
      deck.layout = 'LAYOUT_WIDE'
      const slide = deck.addSlide()
      slide.addText('first', { x: 1, y: 1, w: 4, h: 2 })
      slide.addText('second', { x: 1.2, y: 1.2, w: 4, h: 2 })
      slide.addText('outside', { x: 12.8, y: 7, w: 2, h: 1 })
      return deck
    }`)
    const codes = result.inspection.validation.issues.map((issue) => issue.code)
    assert.ok(codes.includes('pptx-text-overlap'))
    assert.ok(codes.includes('pptx-out-of-bounds'))
  })

  it('模板比较拒绝删除共享版式部件', async () => {
    const root = await tempDirectory()
    const template = join(root, 'template.docx')
    await build(root, template, 'docx', `({ docx }) => new docx.Document({
      sections: [{ children: [new docx.Paragraph('template')] }],
    })`)
    const zip = await JSZip.loadAsync(await readFile(template))
    zip.remove('word/styles.xml')
    const damaged = join(root, 'damaged.docx')
    await writeFile(damaged, await zip.generateAsync({ type: 'nodebuffer' }))
    await assert.rejects(() => compareOfficeTemplate({
      templatePath: template,
      outputPath: damaged,
      format: 'docx',
    }), /共享版式或媒体部件/)

    const modifiedZip = await JSZip.loadAsync(await readFile(template))
    const styles = await modifiedZip.file('word/styles.xml')!.async('string')
    modifiedZip.file('word/styles.xml', styles.replace('</w:styles>', '<!-- changed --></w:styles>'))
    const modified = join(root, 'modified-styles.docx')
    await writeFile(modified, await modifiedZip.generateAsync({ type: 'nodebuffer' }))
    await assert.rejects(() => compareOfficeTemplate({
      templatePath: template,
      outputPath: modified,
      format: 'docx',
    }), /改写了共享版式或媒体部件/)
  })

  it('拒绝路径穿越 ZIP、宏载荷和格式伪装', async () => {
    const root = await tempDirectory()
    const valid = join(root, 'valid.docx')
    await build(root, valid, 'docx', `({ docx }) => new docx.Document({
      sections: [{ children: [new docx.Paragraph('ok')] }],
    })`)

    const macro = await JSZip.loadAsync(await import('node:fs/promises').then((fs) => fs.readFile(valid)))
    macro.file('word/vbaProject.bin', 'macro')
    const macroPath = join(root, 'macro.docx')
    await writeFile(macroPath, await macro.generateAsync({ type: 'nodebuffer' }))
    await assert.rejects(() => inspectOfficeFile(
      macroPath,
      { startUnit: 1, unitCount: 1, view: 'content' },
    ), /宏/)

    const missingOverrideTarget = await JSZip.loadAsync(await readFile(valid))
    missingOverrideTarget.remove('word/styles.xml')
    const missingOverrideTargetPath = join(root, 'missing-content-type-target.docx')
    await writeFile(
      missingOverrideTargetPath,
      await missingOverrideTarget.generateAsync({ type: 'nodebuffer' }),
    )
    await assert.rejects(() => inspectOfficeFile(
      missingOverrideTargetPath,
      { startUnit: 1, unitCount: 1, view: 'content' },
    ), /关系目标不存在/)

    const traversal = new JSZip()
    traversal.file('[Content_Types].xml', '<Types/>')
    traversal.file('word/document.xml', '<w:document/>')
    traversal.file('../outside', 'bad')
    const traversalPath = join(root, 'traversal.docx')
    await writeFile(traversalPath, await traversal.generateAsync({ type: 'nodebuffer' }))
    await assert.rejects(
      () => inspectOfficeFile(
        traversalPath,
        { startUnit: 1, unitCount: 1, view: 'content' },
      ),
      /不安全的部件路径/,
    )

    const disguised = join(root, 'disguised.pptx')
    await writeFile(disguised, await import('node:fs/promises').then((fs) => fs.readFile(valid)))
    await assert.rejects(
      () => inspectOfficeFile(
        disguised,
        { startUnit: 1, unitCount: 1, view: 'content' },
      ),
      /扩展名必须是 \.docx/,
    )
  })

  it('拒绝求值结果不是函数或没有返回对应产物的构建脚本', async () => {
    const root = await tempDirectory()
    const source = join(root, 'builder.js')
    await writeFile(source, 'const value = 1', 'utf8')
    await assert.rejects(() => buildOfficeFile({
      format: 'docx', scriptPath: source, outputPath: join(root, 'invalid.docx'), assets: [],
    }), /求值结果必须是构建函数/)

    await writeFile(source, 'async () => ({})', 'utf8')
    await assert.rejects(() => buildOfficeFile({
      format: 'xlsx', scriptPath: source, outputPath: join(root, 'invalid.xlsx'), assets: [],
    }), /没有返回可序列化/)
  })

  it('构建脚本没有 Node 环境权限，且库能力不接受环境路径', async () => {
    const root = await tempDirectory()
    const source = join(root, 'builder.js')

    await writeFile(source, `async () =>
      ({}).constructor.constructor('return process')()`, 'utf8')
    await assert.rejects(() => buildOfficeFile({
      format: 'docx', scriptPath: source, outputPath: join(root, 'escape.docx'), assets: [],
    }), /构建脚本执行失败/)

    await writeFile(source, `async ({ PptxGenJS }) => {
      const deck = new PptxGenJS()
      deck.addSlide().addImage({ path: 'outside.png', x: 0, y: 0, w: 1, h: 1 })
      return deck
    }`, 'utf8')
    await assert.rejects(() => buildOfficeFile({
      format: 'pptx', scriptPath: source, outputPath: join(root, 'path.pptx'), assets: [],
    }), /必须通过 assets 注入/)

    await writeFile(source, `async ({ ExcelJS }) => {
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.readFile('outside.xlsx')
      return workbook
    }`, 'utf8')
    await assert.rejects(() => buildOfficeFile({
      format: 'xlsx', scriptPath: source, outputPath: join(root, 'read.xlsx'), assets: [],
    }), /不开放 readFile/)
  })

})
