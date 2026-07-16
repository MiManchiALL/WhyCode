import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { preparePdfDrafts, restoredPdfDrafts, type PdfDraft } from './pdf-draft.ts'

describe('PDF 草稿传输', () => {
  it('只通过路径或当前会话不透明 ID 传给 Main', () => {
    const pathDraft: PdfDraft = {
      id: 'path',
      kind: 'path',
      name: 'guide.pdf',
      path: 'E:\\guide.pdf',
      byteLength: 10,
    }
    assert.deepEqual(preparePdfDrafts([pathDraft]), [{ kind: 'path', path: 'E:\\guide.pdf' }])

    const attachment = {
      id: '22222222-2222-4222-8222-222222222222',
      sessionId: '11111111-1111-4111-8111-111111111111',
      name: 'queued.pdf',
      storageName: '22222222-2222-4222-8222-222222222222.pdf',
      mediaType: 'application/pdf' as const,
      sha256: 'a'.repeat(64),
      byteLength: 123,
      pageCount: 7,
    }
    const [restored] = restoredPdfDrafts([{
      id: 'input-1',
      text: '恢复 PDF',
      pdfAttachments: [attachment],
    }])
    assert.ok(restored?.kind === 'stored')
    assert.equal(restored.pageCount, 7)
    assert.deepEqual(preparePdfDrafts([restored]), [{
      kind: 'stored',
      attachmentId: attachment.id,
    }])
  })
})
