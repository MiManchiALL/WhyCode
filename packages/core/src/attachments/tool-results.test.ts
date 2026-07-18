import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { modelMessageSchema, type ModelMessage } from 'ai'
import { dehydrateImageMessages, messagesForModel } from './messages.ts'
import { attachImagesToToolResults } from './tool-results.ts'
import type { ImageAttachment } from './types.ts'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

describe('多模态工具结果', () => {
  it('把图片直接绑定到匹配的 tool_call_id，不创建伪用户历史', () => {
    const messages = attachImagesToToolResults([toolMessage('image-1')], [{
      toolCallId: 'image-1',
      attachments: [attachment()],
      transform: { detail: 'high' },
    }])

    assert.deepEqual(messages.map((message) => message.role), ['tool'])
    assert.doesNotThrow(() => modelMessageSchema.parse(messages[0]))
    assert.match(JSON.stringify(messages), /whycode-attachment-ref:v1:/)
    assert.match(JSON.stringify(messages), /"toolCallId":"image-1"/)
    const part = toolResult(messages[0]!)
    assert.equal(part.output.type, 'content')
    assert.equal(part.output.type === 'content'
      ? part.output.value.filter((item) => item.type === 'file').length
      : 0, 1)
  })

  it('跨后续用户轮次保留引用，并只在请求副本中重新水合像素', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'whycode-tool-image-'))
    try {
      const image = attachment()
      await writeFile(join(directory, image.storageName), PNG)
      const canonical = attachImagesToToolResults([toolMessage('image-1')], [{
        toolCallId: 'image-1',
        attachments: [image],
        transform: { detail: 'high' },
      }])
      canonical.push({ role: 'assistant', content: '已查看。' })
      canonical.push({ role: 'user', content: '继续基于刚才的图片回答。' })

      const request = await messagesForModel(canonical, true, directory, [image])
      assert.equal(JSON.stringify(request).includes(PNG.toString('base64')), true)
      assert.match(JSON.stringify(canonical), /whycode-attachment-ref:v1:/)
      assert.equal(JSON.stringify(canonical).includes(PNG.toString('base64')), false)

      const persistedAgain = dehydrateImageMessages(request)
      assert.match(JSON.stringify(persistedAgain), /whycode-attachment-ref:v1:/)
      assert.equal(JSON.stringify(persistedAgain).includes(PNG.toString('base64')), false)

      const textRequest = await messagesForModel(canonical, false)
      assert.match(JSON.stringify(textRequest), /当前模型不支持识图/)
      assert.doesNotMatch(JSON.stringify(textRequest), /whycode-attachment-ref|iVBORw0KGgo/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('图片没有匹配工具结果时拒绝静默丢失关联', () => {
    assert.throws(
      () => attachImagesToToolResults([toolMessage('other')], [{
        toolCallId: 'missing',
        attachments: [attachment()],
        transform: { detail: 'high' },
      }]),
      /找不到图片对应的工具结果/,
    )
  })
})

function toolMessage(toolCallId: string): ModelMessage {
  return {
    role: 'tool',
    content: [{
      type: 'tool-result',
      toolCallId,
      toolName: 'ViewImage',
      output: { type: 'text', value: '已读取图片。' },
    }],
  }
}

function toolResult(message: ModelMessage) {
  assert.equal(message.role, 'tool')
  const part = message.role === 'tool'
    ? message.content.find((item) => item.type === 'tool-result')
    : undefined
  assert.ok(part?.type === 'tool-result')
  return part
}

function attachment(): ImageAttachment {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    sessionId: '11111111-1111-4111-8111-111111111111',
    name: 'screen.png',
    storageName: '22222222-2222-4222-8222-222222222222.png',
    mediaType: 'image/png',
    byteLength: PNG.byteLength,
    width: 1,
    height: 1,
  }
}
