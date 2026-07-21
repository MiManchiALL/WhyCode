import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { ModelEntry } from '../providers/registry.ts'
import type { PdfProcessor } from '../pdf/processor.ts'
import { preparePdfAttachmentImport } from '../pdf/storage.ts'
import { SessionStore } from '../session/store.ts'
import { READ_PDF_TOOL_NAME } from '../tools/read-pdf/index.ts'
import {
  WEB_FETCH_TOOL_NAME,
  WebPageError,
  createWebFetchTool,
} from '../tools/web-page/index.ts'
import { AgentSession } from './session.ts'

describe('WebFetch Agent 链路', () => {
  it('宿主读取失败作为普通工具结果交还主模型继续判断', async () => {
    let modelCalls = 0
    let approvals = 0
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        modelCalls++
        if (modelCalls === 1) {
          const fetchTool = (options.tools ?? []).find((tool) =>
            tool.type === 'function' && tool.name === WEB_FETCH_TOOL_NAME)
          assert.ok(fetchTool?.type === 'function')
          assert.match(fetchTool.description ?? '', /不受信任的外部数据/)
          return toolStep()
        }
        assert.match(JSON.stringify(options.prompt), /目标网页需要登录或拒绝访问/)
        return finalStep('这个来源无法直接读取，我会改用其它公开来源。')
      },
    })
    const session = new AgentSession({
      model: modelEntry(model),
      providerConfig: { apiKey: 'test' },
      promptContext: { projectDir: null, osPlatform: 'win32' },
      mainTools: [createWebFetchTool({
        fetchPage: async () => { throw new WebPageError('目标网页需要登录或拒绝访问') },
      })],
      emit: () => {},
      requestApproval: async (request) => {
        approvals++
        assert.equal(request.toolName, WEB_FETCH_TOOL_NAME)
        assert.match(request.reason, /公网 IP/)
        return { approved: true, remember: true }
      },
    })

    assert.equal(await session.handleUserMessage('读取这个网页'), 'completed')
    assert.equal(modelCalls, 2)
    assert.equal(approvals, 1)
  })

  it('远程 PDF 随工具 step 登记后可立即与重启后统一使用 ReadPdf', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-agent-web-pdf-'))
    try {
      const source = join(root, 'remote.pdf')
      await writeFile(source, '%PDF-1.4\nremote-pdf-bytes')
      const processor = pdfProcessor()
      const store = new SessionStore(join(root, 'sessions'), { pdfProcessor: processor })
      const journal = await store.create({ projectDir: null, modelId: 'test:web-fetch' })
      const transaction = await preparePdfAttachmentImport(
        [{ kind: 'path', path: source }],
        journal.attachmentDirectory,
        journal.sessionId,
        processor,
        new AbortController().signal,
      )
      await transaction.commit()
      const attachment = { ...transaction.attachments[0]!, origin: 'web' as const }
      await journal.recordUserInput('读取远程 PDF', true)

      let modelCalls = 0
      const model = new MockLanguageModelV4({
        doStream: async (options) => {
          modelCalls++
          if (modelCalls === 1) return toolStep()
          const prompt = JSON.stringify(options.prompt)
          assert.match(prompt, new RegExp(attachment.id))
          assert.equal((options.tools ?? []).some((tool) =>
            tool.type === 'function' && tool.name === READ_PDF_TOOL_NAME), true)
          if (modelCalls === 2) return readPdfStep(attachment.id)
          assert.match(prompt, /远程 PDF 第一页/)
          return finalStep('已通过 ReadPdf 读取。')
        },
      })
      const session = new AgentSession({
        model: modelEntry(model),
        providerConfig: { apiKey: 'test' },
        promptContext: { projectDir: null, osPlatform: 'win32' },
        sessionRecorder: journal,
        pdfProcessor: processor,
        mainTools: [createWebFetchTool({
          fetchPage: async (request) => ({
            kind: 'pdf',
            requestedUrl: request.url,
            finalUrl: request.url,
            contentType: 'application/pdf',
            attachment,
          }),
        })],
        emit: () => {},
        requestApproval: async () => ({ approved: true, remember: true }),
      })

      assert.equal(await session.handleUserMessage('读取远程 PDF'), 'completed')
      assert.equal(modelCalls, 3)
      const reopened = await store.open(journal.sessionId)
      assert.equal(reopened.initialPdfAttachments[0]?.id, attachment.id)
      assert.match(JSON.stringify(reopened.initialMessages), new RegExp(attachment.id))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('远程 PDF 导入后 step 若被中止则回收未提交文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-agent-web-pdf-abort-'))
    try {
      const source = join(root, 'remote.pdf')
      await writeFile(source, '%PDF-1.4\nabort-remote-pdf')
      const processor = pdfProcessor()
      const store = new SessionStore(join(root, 'sessions'), { pdfProcessor: processor })
      const journal = await store.create({ projectDir: null, modelId: 'test:web-fetch' })
      const transaction = await preparePdfAttachmentImport(
        [{ kind: 'path', path: source }],
        journal.attachmentDirectory,
        journal.sessionId,
        processor,
        new AbortController().signal,
      )
      await transaction.commit()
      const attachment = { ...transaction.attachments[0]!, origin: 'web' as const }
      let session!: AgentSession
      session = new AgentSession({
        model: modelEntry(new MockLanguageModelV4({ doStream: [toolStep()] })),
        providerConfig: { apiKey: 'test' },
        promptContext: { projectDir: null, osPlatform: 'win32' },
        sessionRecorder: journal,
        pdfProcessor: processor,
        mainTools: [createWebFetchTool({
          fetchPage: async (request) => ({
            kind: 'pdf',
            requestedUrl: request.url,
            finalUrl: request.url,
            contentType: 'application/pdf',
            attachment,
          }),
        })],
        emit: (event) => {
          if (event.type === 'tool-end') session.abort()
        },
        requestApproval: async () => ({ approved: true, remember: true }),
      })

      assert.equal(await session.handleUserMessage('下载后立即停止'), 'aborted')
      assert.deepEqual(await readdir(journal.attachmentDirectory), [])
      assert.equal((await store.open(journal.sessionId)).initialPdfAttachments.length, 0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function toolStep() {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: 'tool-call' as const,
          toolCallId: 'fetch-1',
          toolName: WEB_FETCH_TOOL_NAME,
          input: JSON.stringify({ url: 'https://example.com/private' }),
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

function finalStep(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start' as const, id: 'final' },
        { type: 'text-delta' as const, id: 'final', delta: text },
        { type: 'text-end' as const, id: 'final' },
        {
          type: 'finish' as const,
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: usage(),
        },
      ],
    }),
  }
}

function readPdfStep(attachmentId: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: 'tool-call' as const,
          toolCallId: 'read-pdf-1',
          toolName: READ_PDF_TOOL_NAME,
          input: JSON.stringify({
            sourceType: 'attachment',
            sourceValue: attachmentId,
            startPage: 1,
            pageCount: 1,
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

function pdfProcessor(): PdfProcessor {
  return {
    async inspect(path) {
      return { pageCount: 2, byteLength: (await stat(path)).size }
    },
    async readPages(_path, options) {
      assert.equal(options.mode, 'text')
      return {
        mode: 'text',
        pageCount: 2,
        pages: [{ pageNumber: options.startPage, text: '远程 PDF 第一页' }],
      }
    },
  }
}

function modelEntry(model: MockLanguageModelV4): ModelEntry {
  return {
    id: 'test:web-fetch',
    displayName: 'Web Fetch Mock',
    provider: 'openai',
    protocol: 'openai-responses',
    capabilities: {
      supportsNativeTools: true,
      supportsImageInput: false,
      reasoningExposure: 'none',
      structuredOutput: 'tool-based',
      promptCaching: 'none',
      contextWindow: 100_000,
      maxOutput: 4_000,
    },
    create: () => model,
  }
}

function usage() {
  return {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  }
}
