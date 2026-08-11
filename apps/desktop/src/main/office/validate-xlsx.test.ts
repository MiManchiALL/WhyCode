import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import JSZip from 'jszip'
import { inspectOfficeFile } from './inspect.ts'
import { buildOfficeFixture as build, officeTempDirectory as tempDirectory } from './office-test-helpers.ts'

describe('XLSX 深层校验', () => {
  it('精确统计混合自闭合与带子元素的 cellXfs', async () => {
    const root = await tempDirectory()
    const output = join(root, 'styles.xlsx')
    await build(root, output, 'xlsx', `async ({ ExcelJS }) => {
      const workbook = new ExcelJS.Workbook()
      workbook.addWorksheet('Data').addRow([
        'This is deliberately long text that relies on wrapText',
        'occupied',
      ])
      return workbook
    }`)

    const baseAttributes = 'numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"'
    const styles = Array.from({ length: 37 }, (_, index) => {
      if (index === 36) {
        return `<xf ${baseAttributes} applyAlignment="1"><alignment wrapText="1"/></xf>`
      }
      return index % 2 === 0
        ? `<xf ${baseAttributes}><alignment vertical="center"/></xf>`
        : `<xf ${baseAttributes}/>`
    }).join('')
    await rewritePart(output, 'xl/styles.xml', (xml) => xml.replace(
      /<cellXfs\b[^>]*>[\s\S]*?<\/cellXfs>/i,
      `<cellXfs count="37">${styles}</cellXfs>`,
    ))
    await rewritePart(output, 'xl/worksheets/sheet1.xml', (xml) => xml.replace(
      /<c\b([^>]*)>/i,
      (_match, attributes: string) => `<c${attributes.replace(/\s+s=(?:"[^"]*"|'[^']*')/i, '')} s="36">`,
    ))

    const validation = await inspectOfficeFile(output, {
      startUnit: 1,
      unitCount: 50,
      view: 'validation',
    })
    assert.equal(validation.units[0]?.kind, 'validation-summary')
  })

  it('接受规范 worksheet 顺序并拒绝 sheetPr 晚于 dimension', async () => {
    const root = await tempDirectory()
    const output = join(root, 'order.xlsx')
    await build(root, output, 'xlsx', `async ({ ExcelJS }) => {
      const workbook = new ExcelJS.Workbook()
      workbook.addWorksheet('Data').addRow(['value'])
      return workbook
    }`)

    await rewritePart(output, 'xl/worksheets/sheet1.xml', (xml) => xml.replace(
      /<dimension\b[^>]*\/>/i,
      (dimension) => `<sheetPr/>${dimension}`,
    ))
    await inspectOfficeFile(output, { startUnit: 1, unitCount: 50, view: 'validation' })

    await rewritePart(output, 'xl/worksheets/sheet1.xml', (xml) => xml.replace(
      /<sheetPr\s*\/>\s*(<dimension\b[^>]*\/>)/i,
      '$1<sheetPr/>',
    ))
    await assert.rejects(
      inspectOfficeFile(output, { startUnit: 1, unitCount: 50, view: 'validation' }),
      /工作表子元素顺序无效：sheetPr 不能位于 dimension 之后/,
    )
  })
})

async function rewritePart(
  path: string,
  partName: string,
  transform: (xml: string) => string,
): Promise<void> {
  const archive = await JSZip.loadAsync(await readFile(path))
  const part = archive.file(partName)
  assert.ok(part, `缺少测试部件：${partName}`)
  const before = await part.async('string')
  const after = transform(before)
  assert.notEqual(after, before, `测试变换没有修改部件：${partName}`)
  archive.file(partName, after)
  await writeFile(path, await archive.generateAsync({ type: 'nodebuffer' }))
}
