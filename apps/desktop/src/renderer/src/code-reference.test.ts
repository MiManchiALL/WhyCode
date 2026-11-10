import assert from 'node:assert/strict'
import { it } from 'node:test'
import { ComposerCodeReferences, codeReferenceMessage, MAX_CODE_REFERENCE_CHARS, splitCodeReferenceMessage, storedCodeReferences } from './code-reference.ts'
import { codeExcerpt, excerptRow } from './code-selection.ts'
import { buildFileDiffHunks, contentLines } from './file-change-presentation.ts'
import { ComposerSubmissions, prependComposerDraft, type ComposerSubmission } from './composer-submissions.ts'
import type { ComposerDraft } from './composer-drafts.ts'

it('拖选按字符保留空白和空行，文件刷新后只标注仍匹配的原文', () => {
  const lines = contentLines('before\r\n  标题😀\r\n\r\nend here\r\nafter')
  const excerpt = codeExcerpt(lines, { start: { row: 1, offset: 1 }, end: { row: 3, offset: 3 }, backward: true }, false)!
  assert.deepEqual(excerpt, { line: 2, endLine: 4, startOffset: 1, text: ' 标题😀\n\nend' })
  assert.equal(excerptRow(lines, excerpt), 1)
  assert.equal(excerptRow(contentLines('before\n  不同\n\nend here\nafter'), excerpt), null)
  assert.equal(excerptRow(contentLines('before\n 标题😀\n\nend here'), excerpt), null)
})

it('统一差异跨越增删时捕获手势起始侧的行号与代码', () => {
  const lines = buildFileDiffHunks('head\nold value\ntail', 'head\nnew value\ntail')[0]!.lines
  const left = codeExcerpt(lines, { start: { row: 1, offset: 4 }, end: { row: 3, offset: 2 }, backward: false }, true)!
  assert.deepEqual(left, { line: 2, endLine: 3, startOffset: 4, text: 'value\nta', side: 'L' })
  assert.equal(excerptRow(lines, left), 1)
  const right = codeExcerpt(lines, { start: { row: 0, offset: 2 }, end: { row: 2, offset: 3 }, backward: true }, true)!
  assert.deepEqual(right, { line: 1, endLine: 2, startOffset: 2, text: 'ad\nnew', side: 'R' })
})

it('相同的模型可见文本交付主消息、BTW 或队列，失败合并只恢复一份待发批注', () => {
  const refs = new ComposerCodeReferences()
  const input = { workspace: '/demo', sshTarget: 'dev', path: '/demo/example.md', version: '当前文件',
    line: 4, endLine: 6, text: '  ```\n\n尾 ' }
  assert.ok(refs.add(input))
  assert.ok(refs.add({ ...input, comment: '检查这段' }))
  const sent = refs.getSnapshot()
  const draft: ComposerDraft = { text: '请求', images: [], pdfs: [], skills: [], restoredInputIds: [], btwMode: null, codeReferences: sent }
  const text = codeReferenceMessage(draft.text, sent)
  assert.ok(text.includes('文件：/demo/example.md\n工作区：/demo（SSH dev）\n版本：当前文件\n行号：4–6'))
  assert.ok(text.includes('````\n  ```\n\n尾 \n````'))
  assert.ok(text.endsWith('批注：检查这段'))
  const submissions = new ComposerSubmissions()
  for (const type of ['user-message-accepted', 'message-queued', 'btw-message-accepted'] as const) {
    const pending: ComposerSubmission = { runtimeId: 'runtime', sessionId: 'session', draft: { ...draft, btwMode: type === 'btw-message-accepted' ? 'btw' : null },
      workActiveAtSubmit: false, previousInputIds: new Set(), abortController: new AbortController() }
    submissions.start(pending)
    if (type === 'message-queued') submissions.receiveEvent('runtime', { type, id: 'queued', text })
    else if (type === 'user-message-accepted') submissions.receiveEvent('runtime', { type, inputId: 'user', startsTurn: true, text })
    else submissions.receiveEvent('runtime', { type, inputId: 'btw', btw: { mode: 'btw', conversationId: 'side', turnIndex: 0 }, text })
    assert.ok(pending.receivedInputId)
    submissions.finish(pending)
  }
  assert.deepEqual(splitCodeReferenceMessage(text), { text: draft.text, references: [input, { ...input, comment: '检查这段' }] })
  assert.deepEqual(prependComposerDraft(draft, { ...draft, text: '继续编辑', codeReferences: [] }).codeReferences, sent)
  assert.deepEqual(storedCodeReferences.parse([sent[0], { ...sent[1], pending: false }]), [sent[0]])
  assert.equal(refs.add({ ...input, text: 'x'.repeat(MAX_CODE_REFERENCE_CHARS) }), false)
  assert.equal(refs.getSnapshot(), sent)
})

it('消息只折叠完整引用，保留代码围栏、批注中的标题和正文空行', () => {
  const ref = { workspace: 'E:\\项目', path: 'E:\\项目\\a.md', version: 'Git 未暂存差异', side: 'L' as const,
    line: 1, endLine: 4, text: '  ````\n# 代码引用\n\n## 选区 1', comment: '第一行\n\n## 选区 2\n文件：示例\n> 引文' }
  const quoted = codeReferenceMessage('', [ref])
  assert.deepEqual(splitCodeReferenceMessage(quoted), { text: '', references: [ref] })
  const body = '解释这份格式\n\n# 代码引用\n\n只是标题。'
  const refs = [ref, { ...ref, version: '当前文件', side: undefined, comment: undefined }]
  const mixed = splitCodeReferenceMessage(codeReferenceMessage(body, refs))
  assert.equal(mixed.text, body)
  assert.equal(mixed.references.length, 2)
  assert.equal(codeReferenceMessage(mixed.text, mixed.references), codeReferenceMessage(body, refs))
  const paragraphs = '第一条建议\n\n> 原评论中的引用\n第二条建议'
  const annotated = codeReferenceMessage('', [{ ...ref, comment: '单行' }]).replace('批注：单行', '批注：' + paragraphs)
  assert.equal(splitCodeReferenceMessage(annotated).references[0]?.comment, paragraphs)
  for (const literal of [body, '前文\n\n' + quoted.replace('所选原文：', '普通示例'), quoted + '\n另写正文']) {
    assert.deepEqual(splitCodeReferenceMessage(literal), { text: literal, references: [] })
  }
})
