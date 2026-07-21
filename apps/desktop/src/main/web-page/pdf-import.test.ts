import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { PdfProcessor } from '@whycode/core'
import { importWebPdfDocument } from './pdf-import.ts'

describe('远程 PDF 会话附件导入', () => {
  it('直接将已限长的网络字节交给既有 PDF 存储事务', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-web-pdf-import-'))
    try {
      const bytes = new TextEncoder().encode('%PDF-1.4\nremote-document')
      const processor: PdfProcessor = {
        async inspect(path) {
          return { pageCount: 7, byteLength: (await stat(path)).size }
        },
        async readPages() {
          throw new Error('导入阶段不应读取 PDF 页面')
        },
      }

      const attachment = await importWebPdfDocument({
        kind: 'pdf',
        requestedUrl: 'https://example.com/download?id=1',
        finalUrl: 'https://cdn.example.com/reports/annual%20report.pdf',
        contentType: 'application/pdf',
        bytes,
      }, {
        attachmentDirectory: root,
        sessionId: '11111111-1111-4111-8111-111111111111',
        processor,
      }, new AbortController().signal)

      assert.equal(attachment.name, 'annual report.pdf')
      assert.equal(attachment.origin, 'web')
      assert.equal(attachment.pageCount, 7)
      assert.deepEqual(
        new Uint8Array(await readFile(join(root, attachment.storageName))),
        bytes,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
