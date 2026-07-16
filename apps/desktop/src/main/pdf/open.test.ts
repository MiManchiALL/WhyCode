import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { openPdfAttachment } from './open.ts'

const attachment = {
  id: '22222222-2222-4222-8222-222222222222',
  sessionId: '11111111-1111-4111-8111-111111111111',
  name: 'guide.pdf',
  storageName: '22222222-2222-4222-8222-222222222222.pdf',
  mediaType: 'application/pdf' as const,
  sha256: 'a'.repeat(64),
  byteLength: 123,
  pageCount: 7,
}

describe('打开 PDF 附件', () => {
  it('只把当前会话中的稳定附件路径交给系统阅读器', async () => {
    let opened = ''
    const journal = { attachmentDirectory: 'E:\\sessions\\attachments', initialPdfAttachments: [attachment] }
    assert.deepEqual(await openPdfAttachment(journal, attachment.id, async (path) => {
      opened = path
      return ''
    }), { ok: true })
    assert.match(opened, /attachments[\\/]22222222-2222-4222-8222-222222222222\.pdf$/)
  })

  it('未知 ID 不触发系统调用，并保留系统打开错误', async () => {
    let calls = 0
    const journal = { attachmentDirectory: 'E:\\sessions\\attachments', initialPdfAttachments: [attachment] }
    assert.equal((await openPdfAttachment(journal, 'unknown', async () => {
      calls++
      return ''
    })).ok, false)
    assert.equal(calls, 0)
    assert.deepEqual(await openPdfAttachment(journal, attachment.id, async () => '没有默认阅读器'), {
      ok: false,
      error: '没有默认阅读器',
    })
  })
})
