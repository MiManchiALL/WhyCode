import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { SessionStore } from '../session/store.ts'
import { createImageUserMessage, messagesForModel } from './messages.ts'
import { importImageAttachments } from './storage.ts'
import { localWorkspace } from '../workspace/types.ts'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

describe('图片会话持久化', () => {
  it('纯图片输入跨重启保持空正文，模型消息不注入分析指令或空文本段', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-image-only-session-'))
    try {
      const store = new SessionStore(root)
      const journal = await store.create({
        workspace: localWorkspace(null),
        modelId: 'zhipu:glm-5v-turbo',
      })
      const source = join(root, 'source.png')
      await writeFile(source, ONE_PIXEL_PNG)
      const attachments = await importImageAttachments(
        [{ kind: 'path', path: source }],
        journal.attachmentDirectory,
        journal.sessionId,
      )

      await assert.rejects(
        journal.recordUserInput('', true),
        /空正文输入必须包含图片/,
      )
      await journal.recordUserInput('', true, attachments)
      await journal.recordTurnStart(
        'turn-image-only',
        [createImageUserMessage('', attachments)],
      )
      await journal.recordTurnEnd('turn-image-only', 'completed')

      const transcript = await readFile(
        join(root, journal.sessionId, 'transcript.jsonl'),
        'utf8',
      )
      assert.match(transcript, /"text":""/)
      assert.doesNotMatch(transcript, /请分析这些图片/)

      const reopened = await store.open(journal.sessionId)
      const visible = reopened.initialViewEvents[0]
      assert.ok(visible?.type === 'user-message')
      assert.equal(visible.text, '')
      assert.deepEqual(visible.attachments, attachments)

      const message = reopened.initialMessages[0]
      assert.ok(message?.role === 'user' && typeof message.content !== 'string')
      assert.equal(
        message.content.some((part) => part.type === 'text' && part.text.length === 0),
        false,
      )
      assert.equal(message.content.some((part) => part.type === 'file'), true)
      assert.doesNotMatch(JSON.stringify(message), /请分析这些图片/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('重启后恢复图片消息，但 transcript 不包含图片 Base64', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-image-session-'))
    try {
      const store = new SessionStore(root)
      const journal = await store.create({ workspace: localWorkspace(null), modelId: 'zhipu:glm-5v-turbo' })
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
      const journal = await store.create({ workspace: localWorkspace(null), modelId: 'zhipu:glm-5v-turbo' })
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

  it('辅助识图输入跨重启保持文字路由，切到视觉模型也不自动水合旧像素', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-aux-image-session-'))
    try {
      const store = new SessionStore(root)
      const journal = await store.create({
        workspace: localWorkspace(null),
        modelId: 'deepseek:deepseek-v4-flash',
      })
      const source = join(root, 'source.png')
      await writeFile(source, ONE_PIXEL_PNG)
      const attachments = await importImageAttachments(
        [{ kind: 'path', path: source }],
        journal.attachmentDirectory,
        journal.sessionId,
      )
      await journal.recordUserInput('分析图片', true, attachments, [], [], 'auxiliary')
      await journal.recordTurnStart(
        'turn-aux-image',
        [createImageUserMessage('分析图片', attachments, 'auxiliary')],
      )
      await journal.recordTurnEnd('turn-aux-image', 'completed')

      const transcript = await readFile(
        join(root, journal.sessionId, 'transcript.jsonl'),
        'utf8',
      )
      assert.match(transcript, /"imageDelivery":"auxiliary"/)
      assert.match(transcript, /WHYCODE_IMAGE_ATTACHMENT/)
      assert.doesNotMatch(transcript, /whycode-attachment-ref|iVBORw0KGgo/)

      const reopened = await store.open(journal.sessionId)
      const message = reopened.initialMessages[0]
      assert.ok(message?.role === 'user' && typeof message.content !== 'string')
      assert.equal(message.content.some((part) => part.type === 'file'), false)
      assert.match(JSON.stringify(message), new RegExp(attachments[0]!.id))

      const visualProjection = await messagesForModel(
        reopened.initialMessages,
        true,
        reopened.attachmentDirectory,
        attachments,
      )
      assert.doesNotMatch(JSON.stringify(visualProjection), /iVBORw0KGgo/)
      assert.equal(
        visualProjection.some((entry) =>
          entry.role === 'user'
          && typeof entry.content !== 'string'
          && entry.content.some((part) => part.type === 'file')),
        false,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('图片已退出模型活动上下文后仍校验历史缩略图文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-image-history-'))
    try {
      const store = new SessionStore(root)
      const journal = await store.create({ workspace: localWorkspace(null), modelId: 'zhipu:glm-5v-turbo' })
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

  it('纯图片插话在送达确认前可恢复，确认后只进入模型历史一次', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-image-steering-'))
    try {
      const store = new SessionStore(root)
      const journal = await store.create({ workspace: localWorkspace(null), modelId: 'zhipu:glm-5v-turbo' })
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
      await journal.recordUserInputWithId(inputId, '', false, attachments)

      const queued = await store.open(journal.sessionId)
      assert.deepEqual(queued.pendingUserInputs, [{
        id: inputId,
        text: '',
        attachments,
        imageDelivery: 'native',
        state: 'queued',
      }])

      await queued.recordStep(
        'turn-steering',
        [createImageUserMessage('', attachments)],
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
