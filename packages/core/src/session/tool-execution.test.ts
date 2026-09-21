import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import type { ModelMessage, ToolResultPart } from 'ai'
import { referencedPdfAttachmentIds } from '../pdf/messages.ts'
import type { PdfAttachment } from '../pdf/types.ts'
import { localWorkspace } from '../workspace/types.ts'
import { buildLoadedSession, parseTranscript } from './chain.ts'
import { SessionStore } from './store.ts'
import { appendOrderedMessages, TOOL_OUTCOME_UNKNOWN } from './tool-execution.ts'

describe('工具历史的统一顺序投影', () => {
  it('排序保留推理签名、消息和结果元数据、附件内容，不跨用户或新调用批次', () => {
    const head = calls()
    const first = result(1)
    const second = result(2)
    second.content[0]!.output = { type: 'content', value: [
      { type: 'text', text: '附件说明' }, { type: 'image-data', data: 'cGl4ZWxz', mediaType: 'image/png' },
    ] }
    const combined: ModelMessage = {
      role: 'tool', content: [...second.content, ...first.content],
      providerOptions: { test: { envelope: '原始响应信息' } },
    }
    const messages: ModelMessage[] = []
    appendOrderedMessages(messages, [head, combined])
    assert.equal(messages[0], head)
    assert.deepEqual(resultIds(messages), ['call-1', 'call-2'])
    assert.deepEqual(messages.slice(1).map((message) => message.providerOptions), [combined.providerOptions, combined.providerOptions])
    const parts = messages.flatMap((message) => message.role === 'tool' ? message.content : [])
    assert.equal(parts[0], first.content[0])
    assert.equal(parts[1], second.content[0])

    const previous = [...messages]
    const user: ModelMessage = { role: 'user', content: '新的一轮' }
    appendOrderedMessages(messages, [user, calls(), result(2), result(1)])
    assert.deepEqual(messages.slice(0, previous.length), previous)
    assert.deepEqual(resultIds(messages.slice(previous.length)), ['call-1', 'call-2'])
    const unrelated: ModelMessage[] = [head, result(2), user]
    appendOrderedMessages(unrelated, [result(1)])
    assert.deepEqual(unrelated, [head, result(2), user, result(1)])
  })

  it('完成次序只影响审计日志，冷恢复、回滚锚点、Fork 和压缩快照保持相同调用次序', async (t) => {
    const { store, journal, transcript } = await setup(t)
    await journal.recordUserInput('原任务', true)
    await journal.recordTurnStart('turn-1', [{ role: 'user', content: '原任务' }])
    await journal.recordStep('turn-1', [calls()])
    await journal.recordStep('turn-1', [result(2)])
    await journal.recordStep('turn-1', [result(1)])
    await journal.recordStep('turn-1', [{ role: 'assistant', content: '第一轮完成' }])
    await journal.recordTurnEnd('turn-1', 'completed')
    await journal.recordViewEvents([{ type: 'core-event', event: {
      type: 'work-finished', durationMs: 10, outcome: 'completed', forkTurnId: 'turn-1',
    } }])
    const expected = [...journal.initialMessages]
    assert.deepEqual(resultIds(expected), ['call-1', 'call-2'])
    const raw = parseTranscript(await readFile(transcript, 'utf8'))
    assert.deepEqual(resultIds(raw.flatMap((entry) => entry.type === 'messages' ? entry.messages : [])), ['call-2', 'call-1'])

    await journal.recordUserInput('继续', true)
    await journal.recordTurnStart('turn-2', [{ role: 'user', content: '继续' }])
    await journal.recordStep('turn-2', [{ role: 'assistant', content: '第二轮完成' }])
    await journal.recordTurnEnd('turn-2', 'completed')
    assert.deepEqual(journal.messagesBeforeTurn('turn-2'), expected)
    const cold = await store.open(journal.sessionId)
    assert.deepEqual(cold.initialMessages, journal.initialMessages)
    assert.deepEqual(cold.messagesBeforeTurn('turn-2'), expected)
    const fork = await store.fork(cold, 'turn-1')
    assert.deepEqual(fork.initialMessages, expected)
    assert.deepEqual((await store.open(fork.sessionId)).initialMessages, expected)

    await cold.recordSnapshot('rollback', cold.messagesBeforeTurn('turn-2')!)
    assert.deepEqual((await store.open(cold.sessionId)).initialMessages, expected)
    const compacted: ModelMessage[] = [{ role: 'user', content: '保留的近期上下文' }, ...expected.slice(1)]
    await cold.recordSnapshot('compact', compacted)
    assert.deepEqual(cold.initialMessages, compacted)
    assert.deepEqual((await store.open(cold.sessionId)).initialMessages, compacted)
  })

  it('较早调用失去结果时，将未知结果补到已完成结果之前，恢复不会重复或覆盖真实结果', async (t) => {
    const { store, journal } = await setup(t)
    await journal.recordTurnStart('turn', [{ role: 'user', content: '并行读取' }])
    await journal.recordStep('turn', [calls()])
    await journal.recordStep('turn', [], undefined, undefined, { startedToolCallId: 'call-1' })
    await journal.recordStep('turn', [result(2)])
    const cold = await store.open(journal.sessionId)
    assert.deepEqual(resultIds(cold.initialMessages), ['call-1', 'call-2'])
    assert.match(JSON.stringify(cold.initialMessages[2]), new RegExp(TOOL_OUTCOME_UNKNOWN))
    assert.deepEqual(cold.initialMessages[3], result(2))
    await cold.recoverInterruptedWork()
    const recovered = await store.open(cold.sessionId)
    assert.deepEqual(resultIds(recovered.initialMessages), ['call-1', 'call-2'])
    assert.deepEqual(recovered.initialMessages[3], result(2))
  })

  it('合并结果拆分排序后，已落盘 PDF 仍在工具结果之后补回引用', async (t) => {
    const { journal, transcript } = await setup(t)
    const id = randomUUID()
    const pdf: PdfAttachment = {
      id, sessionId: journal.sessionId, storageName: `${id}.pdf`, name: 'paper.pdf',
      mediaType: 'application/pdf', sha256: 'a'.repeat(64), byteLength: 100, pageCount: 1, origin: 'web',
    }
    await journal.recordTurnStart('turn', [{ role: 'user', content: '获取两份资料' }])
    await journal.recordStep('turn', [calls()])
    await journal.recordStep('turn', [{ role: 'tool', content: [...result(2).content, ...result(1).content] }],
      undefined, undefined, { pdfAttachments: [pdf] })
    const cold = buildLoadedSession(parseTranscript(await readFile(transcript, 'utf8')))
    assert.deepEqual(resultIds(cold.messages), ['call-1', 'call-2'])
    assert.deepEqual([...referencedPdfAttachmentIds(cold.messages)], [id])
    assert.equal(cold.messages.at(-1)!.role, 'user')
    assert.deepEqual(cold.pdfAttachments, [pdf])
  })
})

function calls(): ModelMessage {
  return { role: 'assistant', content: [
    { type: 'reasoning', text: '先后顺序', providerOptions: { anthropic: { signature: 'signed' } } },
    ...[1, 2].map((n) => ({ type: 'tool-call' as const, toolCallId: `call-${n}`, toolName: 'ReadProbe', input: { n } })),
  ] }
}

function result(n: number): Extract<ModelMessage, { role: 'tool' }> & { content: ToolResultPart[] } {
  return { role: 'tool', content: [{
    type: 'tool-result', toolCallId: `call-${n}`, toolName: 'ReadProbe',
    output: { type: 'text', value: `实际结果 ${n}` }, providerOptions: { test: { result: n } },
  }] }
}

function resultIds(messages: readonly ModelMessage[]): string[] {
  return messages.flatMap((message) => message.role === 'tool'
    ? message.content.flatMap((part) => part.type === 'tool-result' ? [part.toolCallId] : []) : [])
}

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'whycode-tool-history-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new SessionStore(root)
  const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:order' })
  return { store, journal, transcript: join(root, journal.sessionId, 'transcript.jsonl') }
}
