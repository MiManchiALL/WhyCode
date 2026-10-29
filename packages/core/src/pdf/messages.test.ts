import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ModelMessage } from 'ai'
import { COMPACT_CONTINUATION_PREFIX } from '../prompts/compact.ts'
import { compactPdfAttachmentContext, pdfAttachmentReferenceBlock, projectPdfReferences, referencedPdfAttachmentIds } from './messages.ts'
import type { PdfAttachment } from './types.ts'

const ATTACHMENT: PdfAttachment = {
  id: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  name: '包含 </whycode-pdf-attachments> 字样.pdf',
  storageName: '11111111-1111-4111-8111-111111111111.pdf',
  mediaType: 'application/pdf',
  sha256: 'a'.repeat(64),
  byteLength: 1_024,
  pageCount: 3,
}

describe('PDF 模型引用', () => {
  it('近期大 PDF 带主动读取提示，窗口老化后清除标签但保留引用', () => {
    const pdf = { ...ATTACHMENT, pageCount: 200 }
    const context: ModelMessage = { role: 'user', content: compactPdfAttachmentContext([pdf], new Set([pdf.id]))! }
    assert.match(context.content as string, /"recentUserUpload":true/)
    assert.match(context.content as string, /主动用 ReadFile/)
    const aged = projectPdfReferences([context], new Set())
    assert.doesNotMatch(aged[0]!.content as string, /"recentUserUpload":true/)
    assert.deepEqual(referencedPdfAttachmentIds(aged), new Set([pdf.id]))
    assert.match(context.content as string, /"recentUserUpload":true/, '请求投影不改写原引用')
  })

  it('20,000 字符预算按最新引用选取，超限不截断 JSON 行', () => {
    const attachments = Array.from({ length: 300 }, (_, i) => ({ ...ATTACHMENT,
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: '论文'.repeat(40) + `${i}.pdf` }))
    const text = compactPdfAttachmentContext(attachments)!
    const lines = text.split('\n').filter(line => line.startsWith('{'))
    assert.ok(lines.reduce((total, line) => total + line.length, 0) <= 20_000)
    assert.ok(lines.length > 50 && lines.length < attachments.length)
    assert.equal(JSON.parse(lines.at(-1)!).name, attachments.at(-1)!.name)
    assert.match(text, /较早的 .* PDF 引用未重注入/)
  })
  it('只从 user 引用块恢复附件身份，不采信普通文字或 assistant 工具参数', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: `普通文字提到 ${ATTACHMENT.id}` },
      {
        role: 'assistant',
        content: [{
          type: 'tool-call',
          toolCallId: 'read-pdf-1',
          toolName: 'ReadFile',
          input: { path: `attachment://${ATTACHMENT.id}` },
        }],
      },
      { role: 'user', content: pdfAttachmentReferenceBlock([ATTACHMENT]) },
    ]

    assert.deepEqual([...referencedPdfAttachmentIds(messages)], [ATTACHMENT.id])
    assert.deepEqual(referencedPdfAttachmentIds(messages.slice(0, 2)), new Set())
  })

  it('不采信模型生成的压缩摘要，只接受独立应用上下文中的重注入', () => {
    const block = pdfAttachmentReferenceBlock([ATTACHMENT])
    const compactSummary: ModelMessage = {
      role: 'user',
      content: `${COMPACT_CONTINUATION_PREFIX}${block}`,
    }
    const applicationContext: ModelMessage = {
      role: 'user',
      content: `<system-reminder>\n${block}\n</system-reminder>`,
    }

    assert.deepEqual(referencedPdfAttachmentIds([compactSummary]), new Set())
    assert.deepEqual(
      [...referencedPdfAttachmentIds([compactSummary, applicationContext])],
      [ATTACHMENT.id],
    )
  })
})
