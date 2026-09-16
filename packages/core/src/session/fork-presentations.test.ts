import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, it } from 'node:test'
import type { ModelMessage } from 'ai'
import { readPresentationResult, type Presentation } from '../presentation.ts'
import { localWorkspace, type WorkspaceBinding } from '../workspace/types.ts'
import { forkWorkspacePathMapper } from './fork-resources.ts'
import { forkPresentations } from './fork-presentations.ts'
import { parseTranscript } from './chain.ts'
import { SessionStore } from './store.ts'
import type { ViewEvent } from './view-events.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const managed = (path: string): WorkspaceBinding => ({ mode: 'managed', id: randomUUID(), workingDirectory: path, createdAt: new Date().toISOString() })
function messages(declaration: Presentation): ModelMessage[] {
  return [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'delivery', toolName: 'Present', input: declaration }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'delivery', toolName: 'Present', output: { type: 'text', value: JSON.stringify(declaration) } }] }]
}
function view(declaration: Presentation): ViewEvent[] {
  return [{ type: 'core-event', event: { type: 'tool-start', toolUseId: 'delivery', toolName: 'Present', input: declaration } },
    { type: 'core-event', event: { type: 'tool-end', toolUseId: 'delivery', isError: false, result: JSON.stringify(declaration) } }]
}
function outputs(items: readonly ModelMessage[]) {
  return items.flatMap(message => message.role === 'tool' ? message.content.flatMap(part =>
    part.type === 'tool-result' && part.toolName === 'Present' && part.output.type === 'text'
      ? [readPresentationResult(part.output.value)] : []) : [])
}

it('managed Fork rehomes inherited deliveries in canonical history and visible cards, including repeated Fork', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whycode-fork-delivery-')); roots.push(root)
  const store = new SessionStore(root)
  const sourceWorkspace = managed(join(root, 'source'))
  const targetWorkspace = managed(join(root, 'target'))
  const nextWorkspace = managed(join(root, 'next'))
  const declaration: Presentation = {
    files: [{ path: join(root, 'source', 'index.html'), description: '网页' },
      { path: join(root, 'source-sibling', 'external.md') }],
    sources: [{ title: '来源', url: 'https://example.com/source/index.html' }],
  }
  const source = await store.create({ workspace: sourceWorkspace, modelId: 'test:model' })
  await source.recordUserInput('制作网页', true)
  await source.recordTurnStart('first', [{ role: 'user', content: '制作网页' }])
  await source.recordStep('first', messages(declaration))
  await source.recordViewEvents(view(declaration))
  const side = await source.recordBtwInput('btw', '说明这个网页')
  await source.recordBtwResponse(side, { outcome: 'completed', assistantText: '网页说明',
    reasoningText: '', reasoningDurationMs: 0, durationMs: 1,
    toolSteps: [{ messages: messages(declaration), reasoningDurationMs: 0, toolErrors: [] }],
  })
  await source.recordStep('first', [{ role: 'assistant', content: '完成' }])
  await source.recordTurnEnd('first', 'completed')
  // A rollback root retains the previous turn boundary and its messages as well as canonical history.
  await source.recordUserInput('检查网页', true)
  await source.recordTurnStart('second', [{ role: 'user', content: '检查网页' }])
  await source.recordSnapshot('rollback', [...source.initialMessages], 'second')
  await source.recordStep('second', [{ role: 'assistant', content: '完成检查' }])
  await source.recordTurnEnd('second', 'completed')
  await source.recordViewEvents([{ type: 'core-event', event: { type: 'work-finished', durationMs: 1, outcome: 'completed', forkTurnId: 'second' } }])
  const before = await readFile(join(root, source.sessionId, 'transcript.jsonl'), 'utf8')
  const fork = await store.fork(source, 'second', targetWorkspace)
  const expected = { ...declaration, files: [{ ...declaration.files[0], path: join(root, 'target', 'index.html') }, declaration.files[1]] }
  assert.deepEqual(outputs(fork.initialMessages), [expected])
  const sideReply = parseTranscript(await readFile(join(root, fork.sessionId, 'transcript.jsonl'), 'utf8'))
    .find(entry => entry.type === 'btw-response')
  assert.ok(sideReply?.type === 'btw-response')
  assert.deepEqual(outputs(sideReply.toolSteps?.[0]?.messages ?? []), [expected])
  assert.deepEqual(outputs(fork.messagesBeforeTurn('second') ?? []), [expected])
  const card = fork.initialViewEvents.find(value => value.type === 'core-event' && value.event.type === 'tool-end')
  assert.ok(card?.type === 'core-event' && card.event.type === 'tool-end')
  assert.deepEqual(readPresentationResult(String(card.event.result)), expected)
  assert.equal(await readFile(join(root, source.sessionId, 'transcript.jsonl'), 'utf8'), before)
  const secondFork = await store.fork(fork, 'second', nextWorkspace)
  assert.equal(outputs(secondFork.initialMessages)[0]?.files[0]?.path, join(root, 'next', 'index.html'))
  assert.deepEqual(outputs((await store.open(fork.sessionId)).initialMessages), [expected])
})

it('only structured Present paths move; local workspaces, external paths, relative inputs, prose and URLs retain their meaning', () => {
  const root = join(tmpdir(), 'fork-paths')
  const source = managed(join(root, 'source')), target = managed(join(root, 'target'))
  const rebase = forkWorkspacePathMapper(source, target)
  const declaration: Presentation = {
    files: [{ path: 'index.html' }, { path: join(root, 'source', 'index.html') }, { path: join(root, 'external.html') }], sources: [],
  }
  const refs = forkPresentations(rebase)
  assert.equal(rebase('index.html'), 'index.html')
  const projected = outputs(refs.messages(messages(declaration)))[0]!
  assert.deepEqual(projected.files.map(file => file.path), ['index.html', join(root, 'target', 'index.html'), join(root, 'external.html')])
  const ordinary: ModelMessage = { role: 'assistant', content: join(root, 'source', 'index.html') }
  assert.deepEqual(refs.messages([ordinary]), [ordinary])
  assert.deepEqual(forkPresentations(forkWorkspacePathMapper(localWorkspace(root), localWorkspace(root))).messages(messages(declaration)), messages(declaration))
  const unrelated = view(declaration).map(value => value.type === 'core-event' && value.event.type === 'tool-start'
    ? { ...value, event: { ...value.event, toolName: 'ReadFile' } } : value) as ViewEvent[]
  assert.deepEqual(unrelated.map(forkPresentations(rebase).view), unrelated)
  const failed = view(declaration).map(value => value.type === 'core-event' && value.event.type === 'tool-end'
    ? { ...value, event: { ...value.event, isError: true } } : value)
  const failedRefs = forkPresentations(rebase)
  assert.deepEqual(failed.map(failedRefs.view)[1], failed[1])
})
