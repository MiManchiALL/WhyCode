import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { SessionStore } from '../session/store.ts'
import { createImageUserMessage, messagesForModel } from './messages.ts'
import { importImageAttachments } from './storage.ts'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

describe('图片会话持久化', () => {
  it('重启后恢复图片消息，但 transcript 不包含图片 Base64', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-image-session-'))
    try {
      const store = new SessionStore(root)
      const journal = await store.create({ projectDir: null, modelId: 'zhipu:glm-5v-turbo' })
      const source = join(root, 'source.png')
      await writeFile(source, ONE_PIXEL_PNG)
      const attachments = await importImageAttachments(
        [{ kind: 'path', path: source }],
        journal.attachmentDirectory,
        journal.sessionId,
      )
      await journal.recordUserInput('分析图片', true, attachments)
      await journal.recordTurnStart('turn-image', [createImageUserMessage('分析图片', attachments)])
      await journal.recordTurnEnd('turn-image', 'completed')

      const transcript = await readFile(join(root, journal.sessionId, 'transcript.jsonl'), 'utf8')
      assert.doesNotMatch(transcript, /iVBORw0KGgo/)
      assert.match(transcript, /whycode-attachment-ref:v1:/)

      const reopened = await store.open(journal.sessionId)
      assert.equal(reopened.initialViewEvents[0]?.type, 'user-message')
      assert.deepEqual(
        reopened.initialViewEvents[0]?.type === 'user-message'
          ? reopened.initialViewEvents[0].attachments
          : undefined,
        attachments,
      )
      const message = reopened.initialMessages[0]
      assert.ok(message?.role === 'user' && typeof message.content !== 'string')
      const file = message.content.find((part) => part.type === 'file')
      assert.ok(file?.type === 'file' && typeof file.data === 'string')
      assert.match(file.data, /^whycode-attachment-ref:v1:/)
      const [requestMessage] = await messagesForModel(
        reopened.initialMessages,
        true,
        reopened.attachmentDirectory,
        attachments,
      )
      assert.ok(requestMessage?.role === 'user' && typeof requestMessage.content !== 'string')
      const requestFile = requestMessage.content.find((part) => part.type === 'file')
      assert.ok(requestFile?.type === 'file' && typeof requestFile.data === 'string')
      assert.equal(requestFile.data, ONE_PIXEL_PNG.toString('base64'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('崩溃在 turn-start 前时仍从 user-input 附件引用恢复根消息', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-image-recovery-'))
    try {
      const store = new SessionStore(root)
      const journal = await store.create({ projectDir: null, modelId: 'zhipu:glm-5v-turbo' })
      const source = join(root, 'source.png')
      await writeFile(source, ONE_PIXEL_PNG)
      const attachments = await importImageAttachments(
        [{ kind: 'path', path: source }],
        journal.attachmentDirectory,
        journal.sessionId,
      )
      await journal.recordUserInput('尚未交付的图片', true, attachments)

      const reopened = await store.open(journal.sessionId)
      assert.equal(reopened.undeliveredUserInputIds.length, 1)
      const message = reopened.initialMessages[0]
      assert.ok(message?.role === 'user' && typeof message.content !== 'string')
      assert.equal(message.content.some((part) => part.type === 'file'), true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('图片已退出模型活动上下文后仍校验历史缩略图文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-image-history-'))
    try {
      const store = new SessionStore(root)
      const journal = await store.create({ projectDir: null, modelId: 'zhipu:glm-5v-turbo' })
      const source = join(root, 'source.png')
      await writeFile(source, ONE_PIXEL_PNG)
      const attachments = await importImageAttachments(
        [{ kind: 'path', path: source }],
        journal.attachmentDirectory,
        journal.sessionId,
      )
      const [image] = attachments
      assert.ok(image)
      await journal.recordUserInput('分析图片', true, [image])
      await journal.recordTurnStart('turn-image', [createImageUserMessage('分析图片', attachments)])
      await journal.recordTurnEnd('turn-image', 'completed')
      await journal.recordSnapshot('compact', [{ role: 'user', content: '压缩后的文本摘要' }])
      await rm(join(journal.attachmentDirectory, image.storageName))

      await assert.rejects(store.open(journal.sessionId), /ENOENT/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('图片插话在送达确认前可恢复，确认后只进入模型历史一次', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-image-steering-'))
    try {
      const store = new SessionStore(root)
      const journal = await store.create({ projectDir: null, modelId: 'zhipu:glm-5v-turbo' })
      const source = join(root, 'source.png')
      await writeFile(source, ONE_PIXEL_PNG)
      const attachments = await importImageAttachments(
        [{ kind: 'path', path: source }],
        journal.attachmentDirectory,
        journal.sessionId,
      )

      await journal.recordUserInput('开始任务', true)
      await journal.recordTurnStart('turn-steering', [{ role: 'user', content: '开始任务' }])
      const inputId = randomUUID()
      await journal.recordUserInputWithId(inputId, '图片插话', false, attachments)

      const queued = await store.open(journal.sessionId)
      assert.deepEqual(queued.pendingUserInputs, [{
        id: inputId,
        text: '图片插话',
        attachments,
        state: 'queued',
      }])

      await queued.recordStep(
        'turn-steering',
        [createImageUserMessage('图片插话', attachments)],
        undefined,
        undefined,
        { attachments, deliveredInputIds: [inputId] },
      )
      const delivered = await store.open(journal.sessionId)
      assert.deepEqual(delivered.pendingUserInputs, [])
      assert.equal(delivered.initialMessages.length, 2)
      const transcript = await readFile(
        join(root, journal.sessionId, 'transcript.jsonl'),
        'utf8',
      )
      assert.doesNotMatch(transcript, /iVBORw0KGgo/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
