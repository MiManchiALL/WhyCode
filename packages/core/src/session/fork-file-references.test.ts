import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, it } from 'node:test'
import type { ModelMessage } from 'ai'
import { readPresentationResult, type Presentation } from '../presentation.ts'
import { type WorkspaceBinding } from '../workspace/types.ts'
import { forkScratchPathMapper } from './fork-resources.ts'
import { forkFileReferences } from './fork-file-references.ts'
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

it('Fork shares project deliveries and rehomes copied scratch deliveries, including repeated Fork', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whycode-fork-delivery-')); roots.push(root)
  const store = new SessionStore(root)
  const sourceWorkspace = managed(join(root, 'source'))
  const scratch = join(root, 'scratch')
  const source = await store.create({ workspace: sourceWorkspace, modelId: 'test:model' })
  const declaration: Presentation = {
    files: [{ path: join(root, 'source', 'index.html'), description: '网页' },
      { path: join(root, 'source-sibling', 'external.md') },
      { path: join(scratch, source.sessionId, 'Main', 'report.md') }],
    sources: [{ title: '来源', url: 'https://example.com/source/index.html' }],
  }
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
  const fork = await store.fork(source, 'second', scratch)
  const expected = { ...declaration, files: [declaration.files[0], declaration.files[1],
    { ...declaration.files[2], path: join(scratch, fork.sessionId, 'Main', 'report.md') }] }
  assert.deepEqual(fork.metadataSnapshot.workspace, sourceWorkspace)
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
  const secondFork = await store.fork(fork, 'second', scratch)
  assert.equal(outputs(secondFork.initialMessages)[0]?.files[0]?.path, declaration.files[0]?.path)
  assert.equal(outputs(secondFork.initialMessages)[0]?.files[2]?.path, join(scratch, secondFork.sessionId, 'Main', 'report.md'))
  assert.deepEqual(outputs((await store.open(fork.sessionId)).initialMessages), [expected])
})

it('only structured paths move; external paths, relative inputs, file contents, prose and URLs retain their meaning', () => {
  const root = join(tmpdir(), 'fork-paths')
  const rebase = forkScratchPathMapper({ source: join(root, 'source'), target: join(root, 'target') })
  const declaration: Presentation = {
    files: [{ path: 'index.html' }, { path: join(root, 'source', 'index.html') }, { path: join(root, 'external.html') }], sources: [],
  }
  const refs = forkFileReferences(rebase)
  assert.equal(rebase('index.html'), 'index.html')
  const projected = outputs(refs.messages(messages(declaration)))[0]!
  assert.deepEqual(projected.files.map(file => file.path), ['index.html', join(root, 'target', 'index.html'), join(root, 'external.html')])
  const ordinary: ModelMessage = { role: 'assistant', content: join(root, 'source', 'index.html') }
  assert.deepEqual(refs.messages([ordinary]), [ordinary])
  assert.deepEqual(forkFileReferences(forkScratchPathMapper()).messages(messages(declaration)), messages(declaration))
  const unrelated = view(declaration).map(value => value.type === 'core-event' && value.event.type === 'tool-start'
    ? { ...value, event: { ...value.event, toolName: 'ReadFile' } } : value) as ViewEvent[]
  assert.deepEqual(unrelated.map(forkFileReferences(rebase).view), unrelated)
  const failed = view(declaration).map(value => value.type === 'core-event' && value.event.type === 'tool-end'
    ? { ...value, event: { ...value.event, isError: true } } : value)
  const failedRefs = forkFileReferences(rebase)
  assert.deepEqual(failed.map(failedRefs.view)[1], failed[1])
})

it('file tool links and changes follow copied scratch while file contents and command text retain the source facts', () => {
  const root = join(tmpdir(), 'fork-tool-paths')
  const oldPath = join(root, 'source', 'report.md')
  const newPath = join(root, 'target', 'report.md')
  const refs = forkFileReferences(forkScratchPathMapper({ source: join(root, 'source'), target: join(root, 'target') }))
  const canonical: ModelMessage[] = [{ role: 'assistant', content: [
    { type: 'tool-call', toolCallId: 'write', toolName: 'WriteFile', input: { path: oldPath, content: oldPath } },
    { type: 'tool-call', toolCallId: 'edit', toolName: 'EditFile', input: { edits: [{ path: oldPath, oldText: oldPath, newText: newPath }] } },
    { type: 'tool-call', toolCallId: 'run', toolName: 'RunCommand', input: { command: `cat ${oldPath}` } },
  ] }]
  const projected = refs.messages(canonical)[0]
  assert.equal(projected?.role, 'assistant')
  assert.deepEqual(projected?.content, [
    { type: 'tool-call', toolCallId: 'write', toolName: 'WriteFile', input: { path: newPath, content: oldPath } },
    { type: 'tool-call', toolCallId: 'edit', toolName: 'EditFile', input: { edits: [{ path: newPath, oldText: oldPath, newText: newPath }] } },
    { type: 'tool-call', toolCallId: 'run', toolName: 'RunCommand', input: { command: `cat ${oldPath}` } },
  ])
  assert.deepEqual(refs.view({ type: 'core-event', event: {
    type: 'tool-start', toolUseId: 'write', toolName: 'WriteFile', input: { path: oldPath, content: oldPath },
  } }), { type: 'core-event', event: {
    type: 'tool-start', toolUseId: 'write', toolName: 'WriteFile', input: { path: newPath, content: oldPath },
  } })
  assert.deepEqual(refs.view({ type: 'core-event', event: {
    type: 'tool-end', toolUseId: 'write', isError: false, result: `已写入 ${oldPath}`,
    fileChanges: [{ path: oldPath, added: 1, removed: 0 }],
  } }), { type: 'core-event', event: {
    type: 'tool-end', toolUseId: 'write', isError: false, result: `已写入 ${oldPath}`,
    fileChanges: [{ path: newPath, added: 1, removed: 0 }],
  } })
})
