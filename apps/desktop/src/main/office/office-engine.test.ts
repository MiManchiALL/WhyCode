import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import JSZip from 'jszip'
import { buildOfficeFile } from './build-engine.ts'
import { compareOfficeTemplate } from './compare-template.ts'
import { publishVerifiedFile } from './publisher.ts'
import { inspectOfficeFile } from './inspect.ts'
import { runHiddenProcess } from './hidden-process.ts'
import { boundedText, decodeXmlText } from './xml.ts'
import { buildOfficeFixture as build, officeTempDirectory as tempDirectory } from './office-test-helpers.ts'

describe('Office OOXML engine', () => {
  it('生成并检查 DOCX 正文结构', async () => {
    const root = await tempDirectory()
    const output = join(root, 'report.docx')
    const result = await build(root, output, 'docx', `async ({ docx, report }) => {
      report('正在生成报告')
      return new docx.Document({ sections: [{ children: [
        new docx.Paragraph({ text: 'WhyCode Office 报告' }),
        new docx.Paragraph({ text: '第二段正文' }),
      ] }] })
    }`)

    assert.equal(result.inspection.format, 'docx')
    assert.equal(result.inspection.unitCount, 2)
    assert.match(result.inspection.units[0]?.text ?? '', /WhyCode Office 报告/)
    assert.deepEqual(result.progress, ['正在生成报告'])
  })

  it('通过显式模板资源修改现有 OOXML，而不开放文件系统', async () => {
    const root = await tempDirectory()
    const template = join(root, 'template.docx')
    await build(root, template, 'docx', `({ docx }) => new docx.Document({
      sections: [{ children: [new docx.Paragraph('Original value')] }],
    })`)
    const scriptPath = join(root, 'modify.js')
    const outputPath = join(root, 'modified.docx')
    await writeFile(scriptPath, `async ({ JSZip, assets }) => {
      const zip = await JSZip.loadAsync(assets.template.bytes)
      const part = zip.file('word/document.xml')
      if (!part) throw new Error('missing document part')
      const xml = await part.async('string')
      if (xml.split('Original value').length !== 2) throw new Error('target is not unique')
      zip.file('word/document.xml', xml.replace('Original value', 'Updated value'))
      return zip.generateAsync({ type: 'uint8array' })
    }`, 'utf8')

    const result = await buildOfficeFile({
      format: 'docx',
      scriptPath,
      outputPath,
      assets: [{ key: 'template', path: template }],
    })
    assert.match(result.inspection.units[0]?.text ?? '', /Updated value/)
    const templateComparison = await compareOfficeTemplate({
      templatePath: template,
      outputPath,
      format: 'docx',
    })
    assert.equal(templateComparison.removedPartCount, 0)
    assert.equal(templateComparison.modifiedProtectedParts.length, 0)
  })

  it('对象、样式、关系和校验视图返回稳定定位', async () => {
    const root = await tempDirectory()
    const docxPath = join(root, 'views.docx')
    await build(root, docxPath, 'docx', `({ docx }) => new docx.Document({
      styles: { paragraphStyles: [{ id: 'CustomHeading', name: 'Custom Heading',
        basedOn: 'Normal', next: 'Normal', quickFormat: true }] },
      sections: [{ children: [new docx.Paragraph({ text: 'Object view', style: 'CustomHeading' })] }],
    })`)
    const objects = await inspectOfficeFile(docxPath, {
      startUnit: 1, unitCount: 50, view: 'objects',
    })
    assert.ok(objects.units.some((unit) => unit.kind === 'paragraph'
      && unit.locator === 'word/document.xml#paragraph[1]'))
    assert.ok(objects.units.some((unit) => unit.kind === 'section'))
    const styles = await inspectOfficeFile(docxPath, {
      startUnit: 1, unitCount: 50, view: 'styles',
    })
    assert.ok(styles.units.some((unit) => /CustomHeading/.test(unit.locator)))
    const relationships = await inspectOfficeFile(docxPath, {
      startUnit: 1, unitCount: 50, view: 'relationships',
    })
    assert.ok(relationships.units.every((unit) => unit.kind === 'relationship'))
    const validation = await inspectOfficeFile(docxPath, {
      startUnit: 1, unitCount: 50, view: 'validation',
    })
    assert.ok(validation.units.length >= 1)
  })

  it('生成 PPTX，并按演示文稿关系顺序检查幻灯片', async () => {
    const root = await tempDirectory()
    const output = join(root, 'slides.pptx')
    const result = await build(root, output, 'pptx', `async ({ PptxGenJS }) => {
      const deck = new PptxGenJS()
      deck.layout = 'LAYOUT_WIDE'
      deck.addSlide().addText('封面', { x: 1, y: 1, w: 4, h: 1 })
      deck.addSlide().addText('结论', { x: 1, y: 1, w: 4, h: 1 })
      return deck
    }`)

    assert.equal(result.inspection.format, 'pptx')
    assert.equal(result.inspection.unitCount, 2)
    assert.deepEqual(result.inspection.units.map((unit) => unit.text), ['封面', '结论'])
    const objects = await inspectOfficeFile(output, {
      startUnit: 1,
      unitCount: 50,
      view: 'objects',
      slideNumber: 1,
    })
    assert.ok(objects.units.some((unit) => unit.kind === 'shape'
      && /封面/.test(unit.text)
      && /slide1\.xml#shape/.test(unit.locator)))
  })

  it('生成 XLSX，并检查工作表、公式和按行分页', async () => {
    const root = await tempDirectory()
    const output = join(root, 'budget.xlsx')
    const result = await build(root, output, 'xlsx', `async ({ ExcelJS }) => {
      const workbook = new ExcelJS.Workbook()
      const sheet = workbook.addWorksheet('预算')
      sheet.addRow(['项目', '金额'])
      sheet.addRow(['研发', 3])
      sheet.getCell('A3').value = '合计'
      sheet.getCell('B3').value = { formula: 'B2*2', result: 6 }
      return workbook
    }`)

    assert.equal(result.inspection.formulaCount, 1)
    assert.equal(result.inspection.formulaErrorCount, 0)
    const rows = await inspectOfficeFile(output, {
      startUnit: 2,
      unitCount: 2,
      view: 'content',
      sheetName: '预算',
    })
    assert.equal(rows.unitKind, 'row')
    assert.equal(rows.units.length, 2)
    assert.match(rows.units[1]?.text ?? '', /FORMULA\(B2\*2\).*6/)
    assert.equal(rows.nextUnit, null)
    const objects = await inspectOfficeFile(output, {
      startUnit: 1,
      unitCount: 50,
      view: 'objects',
      sheetName: '预算',
      range: 'B2:B3',
    })
    assert.ok(objects.units.some((unit) => unit.locator.endsWith('#cell[B3]')))
    const trace = await inspectOfficeFile(output, {
      startUnit: 1,
      unitCount: 50,
      view: 'formula-trace',
      sheetName: '预算',
      range: 'B3',
    })
    assert.match(trace.units[0]?.text ?? '', /B2/)
  })

  it('发布前后校验哈希，并原子覆盖已有普通文件', async () => {
    const root = await tempDirectory()
    const source = join(root, 'staged.docx')
    const target = join(root, 'final.docx')
    const bytes = Buffer.from('verified-office-bytes')
    await Promise.all([
      writeFile(source, bytes),
      writeFile(target, 'old'),
    ])
    const sha256 = createHash('sha256').update(bytes).digest('hex')

    await publishVerifiedFile(source, target, sha256)
    assert.deepEqual(await readFile(target), bytes)
    await assert.rejects(
      () => publishVerifiedFile(source, root, sha256),
      /不是普通文件/,
    )
  })
})

describe('Office 后台进程', () => {
  it('在后台捕获有界输出', async () => {
    const result = await runHiddenProcess({
      command: process.execPath,
      args: ['-e', "process.stdout.write('ready'); process.stderr.write('notice')"],
      workingDirectory: await tempDirectory(),
      abortSignal: new AbortController().signal,
      timeoutMs: 5_000,
    })

    assert.deepEqual(result, { stdout: 'ready', stderr: 'notice' })
  })

  it('超时后等待定向清理完成再返回', async () => {
    let cleanupCompleted = false
    await assert.rejects(
      runHiddenProcess({
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 10_000)'],
        workingDirectory: await tempDirectory(),
        abortSignal: new AbortController().signal,
        timeoutMs: 50,
        onForcedTermination: async () => {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
          cleanupCompleted = true
        },
      }),
      (error) => error instanceof Error
        && 'code' in error
        && error.code === 'timeout',
    )
    assert.equal(cleanupCompleted, true)
  })
})

describe('Office 文本边界', () => {
  it('截断不超过预算且不生成孤立 Unicode 代理项', () => {
    assert.equal(boundedText(`${'a'.repeat(4)}😀tail`, 6), 'aaaa…')
    assert.equal(boundedText('abcdef', 4), 'abc…')
    assert.equal(decodeXmlText('&#xD800;'), '\uFFFD')
  })
})
