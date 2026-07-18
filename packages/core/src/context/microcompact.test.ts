import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ModelMessage } from 'ai'
import { attachImagesToToolResults } from '../attachments/tool-results.ts'
import type { ImageAttachment } from '../attachments/types.ts'
import { READ_PDF_TOOL_NAME } from '../tools/read-pdf/index.ts'
import {
  CLEARED_MESSAGE,
  microcompact,
} from './microcompact.ts'

describe('PDF 工具结果微清理', () => {
  it('清理旧 ReadPdf 文字结果时同步移除配对页面图', () => {
    const messages: ModelMessage[] = []
    for (let index = 0; index < 6; index++) {
      const toolCallId = `pdf-${index}`
      messages.push(...attachImagesToToolResults([toolResult(toolCallId)], [{
        toolCallId,
        attachments: [imageAttachment(index)],
        transform: { detail: 'high' },
      }]))
    }
    const compacted = microcompact(messages)
    assert.ok(compacted)
    assert.match(JSON.stringify(compacted[0]), new RegExp(CLEARED_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(JSON.stringify(compacted.at(-1)), /whycode-attachment-ref/)
  })
})

function toolResult(toolCallId: string): ModelMessage {
  return {
    role: 'tool',
    content: [{
      type: 'tool-result',
      toolCallId,
      toolName: READ_PDF_TOOL_NAME,
      output: { type: 'text', value: `PDF ${toolCallId}` },
    }],
  }
}

function imageAttachment(index: number): ImageAttachment {
  const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
  return {
    id,
    sessionId: '11111111-1111-4111-8111-111111111111',
    name: `page-${index}.png`,
    storageName: `${id}.png`,
    mediaType: 'image/png',
    width: 1,
    height: 1,
    byteLength: 68,
    sha256: String(index).repeat(64).slice(0, 64),
  }
}
