import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { OfficeProcessor, PdfProcessor, ScreenshotCaptureHandler } from '@whycode/core'

export const SMALL_JPEG = Buffer.from(
  '/9j/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAEAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AD//Z',
  'base64',
)

export function documentProcessors() {
  const operations: string[] = []
  const pdfProcessor: PdfProcessor = {
    async inspect(path) {
      return { pageCount: 1, byteLength: (await stat(path)).size }
    },
    async readPages(path, options) {
      await stat(path)
      operations.push(`pdf:${options.mode}`)
      return options.mode === 'text'
        ? { mode: 'text', pageCount: 1, pages: [{ pageNumber: 1, text: '第一页正文' }] }
        : { mode: 'visual', pageCount: 1, renderedPages: [await pageImage(options.outputDirectory)] }
    },
  }
  const officeProcessor: OfficeProcessor = {
    async inspect(path) {
      const { size } = await stat(path)
      operations.push('office:inspect')
      return {
        format: 'pptx', byteLength: size, sha256: 'a'.repeat(64), unitKind: 'slide',
        unitCount: 1, nextUnit: null, metadata: [], formulaCount: 0,
        formulaErrorCount: 0, formulaUncalculatedCount: 0,
        units: [{ index: 1, label: '幻灯片 1', kind: 'slide', locator: 'slide:1', text: '模板标题' }],
        validation: { checkedPartCount: 1, relationshipCount: 0, internalRelationshipCount: 0, issues: [] },
      }
    },
    async renderPages(path, options) {
      await stat(path)
      operations.push('office:render')
      return {
        format: 'pptx', pageCount: 1, renderer: 'microsoft-office',
        renderedPages: [await pageImage(options.outputDirectory)],
      }
    },
  }
  const captureScreenshot: ScreenshotCaptureHandler = async () => {
    operations.push('screenshot')
    return { name: '测试窗口.jpg', bytes: SMALL_JPEG, description: '隔离测试截图' }
  }
  return { pdfProcessor, officeProcessor, captureScreenshot, operations }
}

async function pageImage(directory: string) {
  const path = join(directory, 'page.jpg')
  await writeFile(path, SMALL_JPEG)
  return { pageNumber: 1, path, width: 4, height: 4 }
}
