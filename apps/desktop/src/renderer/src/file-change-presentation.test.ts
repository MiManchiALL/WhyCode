import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Block } from './conversation-state.ts'
import {
  buildFileDiffHunks,
  currentWorkFileChanges,
  firstChangedLine,
} from './file-change-presentation.ts'

describe('文件变更展示投影', () => {
  it('只汇总当前工作中三个专用文件工具的成功变更', () => {
    const blocks: Block[] = [
      tool('old', 'WriteFile', 'old.ts', 9, 0),
      { kind: 'work-duration', id: 'done', forkTurnId: null, durationMs: 1, outcome: 'completed' },
      tool('write', 'WriteFile', 'src/app.ts', 2, 0),
      tool('edit', 'EditFile', 'src/app.ts', 3, 1),
      tool('delete', 'DeleteFile', 'src/old.ts', 0, 4),
      tool('move', 'MoveFile', 'src/moved.ts', 8, 8),
      { ...tool('failed', 'WriteFile', 'bad.ts', 1, 0), call: {
        ...tool('failed', 'WriteFile', 'bad.ts', 1, 0).call,
        status: 'error',
      } },
    ]
    assert.deepEqual(currentWorkFileChanges(blocks), [
      { path: 'src/app.ts', name: 'app.ts', added: 5, removed: 1 },
      { path: 'src/old.ts', name: 'old.ts', added: 0, removed: 4 },
    ])
  })

  it('新的主对话用户消息会开始新的 turn，临时侧对话不会清空汇总', () => {
    const blocks: Block[] = [
      user('first'),
      tool('first-write', 'WriteFile', 'first.ts', 1, 0),
      { ...user('aside'), btw: { conversationId: 'btw-1', turnIndex: 0, mode: 'btw' } },
      tool('aside-write', 'WriteFile', 'aside.ts', 2, 0),
      user('second'),
      tool('second-write', 'WriteFile', 'second.ts', 3, 0),
    ]
    assert.deepEqual(currentWorkFileChanges(blocks), [
      { path: 'second.ts', name: 'second.ts', added: 3, removed: 0 },
    ])
  })

  it('生成带上下文的多个差异块并定位第一处新增行', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].join('\n')
    const after = ['a', 'B', 'c', 'd', 'e', 'f', 'g', 'H', 'i'].join('\n')
    const hunks = buildFileDiffHunks(before, after, 1)
    assert.equal(hunks.length, 2)
    assert.deepEqual(
      hunks[0]?.lines.filter((line) => line.kind !== 'context').map((line) => [
        line.kind,
        line.oldLine,
        line.newLine,
        line.text,
      ]),
      [
        ['removed', 2, null, 'b'],
        ['added', null, 2, 'B'],
      ],
    )
    assert.equal(firstChangedLine(before, after), 2)
  })
})

function tool(
  id: string,
  name: string,
  path: string,
  added: number,
  removed: number,
): Extract<Block, { kind: 'tool' }> {
  return {
    kind: 'tool',
    id: `block-${id}`,
    call: {
      id,
      name,
      input: {},
      status: 'done',
      progress: '',
      fileChanges: [{ path, added, removed }],
    },
  }
}

function user(id: string): Extract<Block, { kind: 'user' }> {
  return { kind: 'user', id, text: id }
}
