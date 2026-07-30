import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { ModelEntry } from '../providers/registry.ts'
import type { PdfProcessor } from '../pdf/processor.ts'
import { withPdfAttachmentReferences } from '../pdf/messages.ts'
import { preparePdfAttachmentImport } from '../pdf/storage.ts'
import { SessionStore } from '../session/store.ts'
import { READ_PDF_TOOL_NAME } from '../tools/read-pdf/index.ts'
import { AgentSession } from './session.ts'
import { localWorkspace } from '../workspace/types.ts'

const SMALL_JPEG = Buffer.from(
  '/9j/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAEAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AD//Z',
  'base64',
)

describe('ReadPdf Agent 链路', () => {
  it('文字模型也能按稳定附件 ID 读取，且 PDF 字节不进入模型上下文', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-agent-pdf-'))
    try {
      const source = join(root, 'guide.pdf')
      await writeFile(source, '%PDF-1.4\nprivate-pdf-bytes')
      const processor = fakeProcessor()
      const store = new SessionStore(join(root, 'sessions'), { pdfProcessor: processor })
      const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:text' })
      const transaction = await preparePdfAttachmentImport(
        [{ kind: 'path', path: source }],
        journal.attachmentDirectory,
        journal.sessionId,
        processor,
        new AbortController().signal,
      )
      await transaction.commit()
      const [attachment] = transaction.attachments
      assert.ok(attachment)
      await journal.recordUserInput('请读 PDF', true, [], transaction.attachments)

      let call = 0
      const model = new MockLanguageModelV4({
        doStream: async (options) => {
          call++
          assert.equal(toolNames(options).includes(READ_PDF_TOOL_NAME), true)
          const prompt = JSON.stringify(options.prompt)
          assert.match(prompt, new RegExp(attachment.id))
          assert.equal(prompt.includes('private-pdf-bytes'), false)
          if (call === 1) return readPdfStep(attachment.id)
          assert.match(prompt, /第一页正文/)
          return finalStep('文档已读取。')
        },
      })
      const session = new AgentSession({
        model: modelEntry(model),
        providerConfig: { apiKey: 'test' },
        promptContext: { projectDir: null, osPlatform: 'win32' },
        sessionRecorder: journal,
        pdfProcessor: processor,
        emit: () => {},
        requestApproval: async () => ({ approved: false }),
      })
      assert.equal(
        await session.handleUserMessage('请读 PDF', false, [], undefined, transaction.attachments),
        'completed',
      )
      assert.equal(call, 2)

      const reopened = await store.open(journal.sessionId)
      assert.equal(reopened.initialPdfAttachments.length, 1)
      assert.match(JSON.stringify(reopened.initialMessages), new RegExp(attachment.id))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('视觉模型在首个请求自动获得小 PDF 页面图且不混入提取正文', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-agent-inline-pdf-'))
    try {
      const source = join(root, 'paper.pdf')
      await writeFile(source, '%PDF-1.4\nprivate-inline-pdf-bytes')
      const processor = visualProcessor()
      const store = new SessionStore(join(root, 'sessions'), { pdfProcessor: processor })
      const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:vision' })
      const transaction = await preparePdfAttachmentImport(
        [{ kind: 'path', path: source }],
        journal.attachmentDirectory,
        journal.sessionId,
        processor,
        new AbortController().signal,
      )
      await transaction.commit()
      await journal.recordUserInput('直接阅读小 PDF', true, [], transaction.attachments)
      const model = new MockLanguageModelV4({
        doStream: async (options) => {
          const prompt = JSON.stringify(options.prompt)
          assert.doesNotMatch(prompt, /第 1 页正文/)
          assert.match(prompt, /第 1 页页面图/)
          assert.equal(prompt.includes(SMALL_JPEG.toString('base64')), true)
          assert.equal(prompt.includes('private-inline-pdf-bytes'), false)
          return finalStep('已直接阅读。')
        },
      })
      const session = new AgentSession({
        model: modelEntry(model, true),
        providerConfig: { apiKey: 'test' },
        promptContext: { projectDir: null, osPlatform: 'win32' },
        sessionRecorder: journal,
        pdfProcessor: processor,
        emit: () => {},
        requestApproval: async () => ({ approved: false }),
      })
      assert.equal(
        await session.handleUserMessage('直接阅读小 PDF', false, [], undefined, transaction.attachments),
        'completed',
      )
      const reopened = await store.open(journal.sessionId)
      assert.equal(JSON.stringify(reopened.initialMessages).includes(SMALL_JPEG.toString('base64')), false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('视觉模型可在一次 ReadPdf 中接收并持久化二十页内部页面图而不展示', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-agent-pdf-twenty-pages-'))
    try {
      const source = join(root, 'twenty-pages.pdf')
      await writeFile(source, '%PDF-1.4\ntwenty-pages')
      const processor = visualProcessor(20)
      const store = new SessionStore(join(root, 'sessions'), { pdfProcessor: processor })
      const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:vision' })
      const transaction = await preparePdfAttachmentImport(
        [{ kind: 'path', path: source }],
        journal.attachmentDirectory,
        journal.sessionId,
        processor,
        new AbortController().signal,
      )
      await transaction.commit()
      const attachment = transaction.attachments[0]!
      await journal.recordUserInput('阅读全部二十页', true, [], [attachment])
      let call = 0
      const model = new MockLanguageModelV4({
        doStream: async (options) => {
          call++
          if (call === 1) return readPdfStep(attachment.id, 'read-twenty-pages', 20)
          assert.match(JSON.stringify(options.prompt), /第 20 页\.jpg/)
          return finalStep('二十页已读完。')
        },
      })
      const viewedCounts: number[] = []
      const session = new AgentSession({
        model: modelEntry(model, true),
        providerConfig: { apiKey: 'test' },
        promptContext: { projectDir: null, osPlatform: 'win32' },
        sessionRecorder: journal,
        pdfProcessor: processor,
        emit: (event) => {
          if (event.type === 'image-viewed') viewedCounts.push(event.attachments.length)
        },
        requestApproval: async () => ({ approved: false }),
      })

      assert.equal(
        await session.handleUserMessage('阅读全部二十页', false, [], undefined, [attachment]),
        'completed',
      )
      assert.equal(call, 2)
      assert.deepEqual(viewedCounts, [])
      const reopened = await store.open(journal.sessionId)
      assert.equal(reopened.initialImageAttachments.length, 20)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('同一步重复读取时不会删除前一回合复用的 PDF 页面图', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-agent-pdf-reuse-'))
    try {
      const source = join(root, 'long.pdf')
      await writeFile(source, '%PDF-1.4\nlong-pdf')
      const processor = visualProcessor(6)
      const store = new SessionStore(join(root, 'sessions'), { pdfProcessor: processor })
      const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:vision' })
      const transaction = await preparePdfAttachmentImport(
        [{ kind: 'path', path: source }],
        journal.attachmentDirectory,
        journal.sessionId,
        processor,
        new AbortController().signal,
      )
      await transaction.commit()
      const attachment = transaction.attachments[0]!
      let call = 0
      const model = new MockLanguageModelV4({
        doStream: async () => {
          call++
          if (call === 1) return readPdfStep(attachment.id, 'initial-read', 4)
          if (call === 3) return repeatedReadPdfStep(attachment.id)
          return finalStep('已读取。')
        },
      })
      const session = new AgentSession({
        model: modelEntry(model, true),
        providerConfig: { apiKey: 'test' },
        promptContext: { projectDir: null, osPlatform: 'win32' },
        sessionRecorder: journal,
        pdfProcessor: processor,
        emit: () => {},
        requestApproval: async () => ({ approved: false }),
      })

      await journal.recordUserInput('先读前四页', true, [], [attachment])
      assert.equal(
        await session.handleUserMessage('先读前四页', false, [], undefined, [attachment]),
        'completed',
      )
      await journal.recordUserInput('再读一次', true)
      assert.equal(await session.handleUserMessage('再读一次'), 'completed')
      assert.equal(call, 4)
      const reopened = await store.open(journal.sessionId)
      assert.equal(reopened.initialImageAttachments.length, 4)
      await Promise.all(reopened.initialImageAttachments.map((image) =>
        stat(join(journal.attachmentDirectory, image.storageName))))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('讨论与协议回合物理移除 ReadPdf', async () => {
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        assert.equal(toolNames(options).includes(READ_PDF_TOOL_NAME), false)
        return finalStep('不读取 PDF。')
      },
    })
    const session = new AgentSession({
      model: modelEntry(model),
      providerConfig: { apiKey: 'test' },
      promptContext: {
        projectDir: null,
        osPlatform: 'win32',
        discussion: { agentId: 'B', scratchDir: process.cwd() },
      },
      pdfProcessor: fakeProcessor(),
      emit: () => {},
      requestApproval: async () => ({ approved: false }),
    })
    assert.equal(await session.handleUserMessage('讨论'), 'completed')
  })

  it('对话回滚后不因 assistant 工具参数或重启重新激活旧 PDF', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-agent-pdf-rollback-'))
    try {
      const source = join(root, 'old.pdf')
      await writeFile(source, '%PDF-1.4\nrolled-back')
      let readCount = 0
      const processor = fakeProcessor(() => { readCount++ })
      const store = new SessionStore(join(root, 'sessions'), { pdfProcessor: processor })
      const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:text' })
      const transaction = await preparePdfAttachmentImport(
        [{ kind: 'path', path: source }],
        journal.attachmentDirectory,
        journal.sessionId,
        processor,
        new AbortController().signal,
      )
      await transaction.commit()
      const [attachment] = transaction.attachments
      assert.ok(attachment)
      await journal.recordUserInput('原始 PDF', true, [], [attachment])
      const originalTurnId = crypto.randomUUID()
      await journal.recordTurnStart(originalTurnId, [{
        role: 'user',
        content: withPdfAttachmentReferences('原始 PDF', [attachment]),
      }])
      await journal.recordTurnEnd(originalTurnId, 'completed')
      await journal.recordSnapshot('rollback', [])

      const first = sessionThatProbesUnavailablePdf(journal, processor, attachment.id)
      await journal.recordUserInput('尝试读取已回滚 PDF', true)
      assert.equal(await first.handleUserMessage('尝试读取已回滚 PDF'), 'completed')

      const reopened = await store.open(journal.sessionId)
      const second = sessionThatProbesUnavailablePdf(reopened, processor, attachment.id)
      await reopened.recordUserInput('重启后再次尝试', true)
      assert.equal(await second.handleUserMessage('重启后再次尝试'), 'completed')
      assert.equal(readCount, 0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function fakeProcessor(onRead?: () => void): PdfProcessor {
  return {
    async inspect(path) {
      return { pageCount: 2, byteLength: (await stat(path)).size }
    },
    async readPages(_path, options) {
      onRead?.()
      return {
        mode: 'text',
        pageCount: 2,
        pages: [{ pageNumber: options.startPage, text: '第一页正文' }],
      }
    },
  }
}

function visualProcessor(totalPages = 2): PdfProcessor {
  return {
    async inspect(path) {
      return { pageCount: totalPages, byteLength: (await stat(path)).size }
    },
    async readPages(_path, options) {
      const count = Math.min(options.pageCount, totalPages - options.startPage + 1)
      if (options.mode === 'text') {
        return {
          mode: 'text',
          pageCount: totalPages,
          pages: Array.from({ length: count }, (_, index) => ({
            pageNumber: options.startPage + index,
            text: `第 ${options.startPage + index} 页正文`,
          })),
        }
      }
      await mkdir(options.outputDirectory, { recursive: true })
      const renderedPages = []
      for (let index = 0; index < count; index++) {
        const pageNumber = options.startPage + index
        const path = join(
          options.outputDirectory,
          `page-${String(pageNumber).padStart(4, '0')}.jpg`,
        )
        await writeFile(path, SMALL_JPEG)
        renderedPages.push({ pageNumber, path, width: 1, height: 1 })
      }
      return { mode: 'visual', pageCount: totalPages, renderedPages }
    },
  }
}

function sessionThatProbesUnavailablePdf(
  journal: Awaited<ReturnType<SessionStore['open']>>,
  processor: PdfProcessor,
  attachmentId: string,
): AgentSession {
  let call = 0
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      call++
      if (call === 1) return readPdfStep(attachmentId, `read-pdf-${crypto.randomUUID()}`)
      assert.match(JSON.stringify(options.prompt), /PDF 附件不存在或不属于当前会话/)
      return finalStep('旧附件不可读取。')
    },
  })
  return new AgentSession({
    model: modelEntry(model),
    providerConfig: { apiKey: 'test' },
    promptContext: { projectDir: null, osPlatform: 'win32' },
    sessionRecorder: journal,
    pdfProcessor: processor,
    emit: () => {},
    requestApproval: async () => ({ approved: false }),
  })
}

function modelEntry(model: MockLanguageModelV4, supportsImageInput = false): ModelEntry {
  return {
    id: 'test:text',
    displayName: 'ReadPdf Mock',
    provider: 'openai',
    protocol: 'openai-responses',
    capabilities: {
      supportsNativeTools: true,
      supportsImageInput,
      reasoningExposure: 'none',
      structuredOutput: 'tool-based',
      promptCaching: 'none',
      contextWindow: 100_000,
      maxOutput: 4_000,
    },
    create: () => model,
  }
}

function readPdfStep(attachmentId: string, toolCallId = 'read-pdf-1', pageCount = 1) {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: 'tool-call' as const,
          toolCallId,
          toolName: READ_PDF_TOOL_NAME,
          input: JSON.stringify({
            sourceType: 'attachment',
            sourceValue: attachmentId,
            startPage: 1,
            pageCount,
          }),
        },
        {
          type: 'finish' as const,
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage: usage(),
        },
      ],
    }),
  }
}

function repeatedReadPdfStep(attachmentId: string) {
  const input = JSON.stringify({
    sourceType: 'attachment',
    sourceValue: attachmentId,
    startPage: 1,
    pageCount: 4,
  })
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'tool-call' as const, toolCallId: 'repeat-one', toolName: READ_PDF_TOOL_NAME, input },
        { type: 'tool-call' as const, toolCallId: 'repeat-two', toolName: READ_PDF_TOOL_NAME, input },
        {
          type: 'finish' as const,
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage: usage(),
        },
      ],
    }),
  }
}

function finalStep(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start' as const, id: 'text-1' },
        { type: 'text-delta' as const, id: 'text-1', delta: text },
        { type: 'text-end' as const, id: 'text-1' },
        {
          type: 'finish' as const,
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: usage(),
        },
      ],
    }),
  }
}

function usage() {
  return {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
  }
}

function toolNames(options: { tools?: Array<{ name: string }> }): string[] {
  return options.tools?.map((tool) => tool.name) ?? []
}
