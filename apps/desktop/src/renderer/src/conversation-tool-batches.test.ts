import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Block } from './conversation-state.ts'
import {
  presentToolBatches,
  presentToolSegmentContent,
  summarizeToolBatch,
  toolBatchRows,
  type ToolBatch,
} from './conversation-tool-batches.ts'

describe('工具批次折叠投影', () => {
  it('只在后续文本出现后折叠此前工具，最新工具保持原卡片', () => {
    const blocks = [
      text('text-1', '阶段一'),
      tool('tool-1', 'ReadFile'),
      tool('tool-2', 'Grep'),
      text('text-2', '阶段二'),
      tool('tool-3', 'RunCommand'),
    ]
    const result = presentToolBatches(blocks)
    assert.deepEqual(result.map((item) => [item.kind, item.id]), [
      ['block', 'text-1'],
      ['tool-segment', 'tool-batch-tool-1'],
      ['block', 'text-2'],
      ['tool-segment', 'tool-batch-tool-3'],
    ])
    assert.equal(result[1]?.kind === 'tool-segment' ? result[1].sealed : null, true)
    assert.equal(result[3]?.kind === 'tool-segment' ? result[3].sealed : null, false)
  })

  it('最终正文被单独投影时可封口最后一个工具批次', () => {
    const result = presentToolBatches([
      text('text-1', '阶段一'),
      tool('tool-1', 'ReadFile'),
      { kind: 'thinking', id: 'thinking-1', text: '继续确认', durationMs: 1 },
      tool('tool-2', 'Grep'),
    ], true)
    assert.deepEqual(result.map((item) => [item.kind, item.id]), [
      ['block', 'text-1'],
      ['tool-segment', 'tool-batch-tool-1'],
    ])
    assert.equal(result[1]?.kind === 'tool-segment' ? result[1].batch.tools.length : 0, 2)
    assert.deepEqual(
      result[1]?.kind === 'tool-segment'
        ? result[1].blocks.map((block) => block.id)
        : [],
      ['block-tool-1', 'thinking-1', 'block-tool-2'],
    )
  })

  it('末批工具封口前后沿用同一 segment 身份供局部折叠过渡', () => {
    const blocks = [tool('tool-1', 'ReadFile'), tool('tool-2', 'Grep')]
    const [open] = presentToolBatches(blocks)
    const [sealed] = presentToolBatches(blocks, true)
    assert.equal(open?.kind, 'tool-segment')
    assert.equal(sealed?.kind, 'tool-segment')
    assert.equal(open?.id, sealed?.id)
    assert.equal(open?.kind === 'tool-segment' ? open.sealed : null, false)
    assert.equal(sealed?.kind === 'tool-segment' ? sealed.sealed : null, true)
  })

  it('没有工具时直接合并最终可见的相邻思考', () => {
    const result = presentToolBatches([
      thinking('thinking-1', '先定位', 3_000),
      thinking('thinking-2', '再确认', 2_000),
    ])

    assert.equal(result.length, 1)
    const merged = result[0]?.kind === 'block' ? result[0].block : null
    assert.deepEqual(merged, {
      kind: 'thinking',
      id: 'thinking-1',
      text: '先定位\n\n再确认',
      durationMs: 5_000,
    })
  })

  it('按真实工具折叠后的可见顺序合并思考', () => {
    const [item] = presentToolBatches([
      tool('skill-1', 'Skill'),
      thinking('thinking-1', '规划目录扫描', 3_728),
      tool('skill-2', 'Skill'),
      tool('skill-3', 'Skill'),
      tool('skill-4', 'Skill'),
      tool('list-1', 'ListDir'),
      thinking('thinking-2', '检查仓库细节', 466),
      thinking('thinking-3', '整理任务计划', 37),
    ], true)
    assert.equal(item?.kind, 'tool-segment')
    if (item?.kind !== 'tool-segment') return

    const sealed = presentToolSegmentContent(item, true)
    assert.deepEqual(sealed.map((entry) => [entry.kind, entry.id]), [
      ['tool-batch', 'tool-batch-skill-1'],
      ['block', 'thinking-1'],
    ])
    const merged = sealed[1]?.kind === 'block' ? sealed[1].block : null
    assert.deepEqual(merged, {
      kind: 'thinking',
      id: 'thinking-1',
      text: '规划目录扫描\n\n检查仓库细节\n\n整理任务计划',
      durationMs: 4_231,
    })
  })

  it('未封口工具仍是思考合并的可见边界', () => {
    const [item] = presentToolBatches([
      tool('read-1', 'ReadFile'),
      thinking('thinking-1', '第一段', 3_000),
      tool('read-2', 'ReadFile'),
      thinking('thinking-2', '第二段', 400),
      thinking('thinking-3', '第三段', 100),
    ])
    assert.equal(item?.kind, 'tool-segment')
    if (item?.kind !== 'tool-segment') return

    const open = presentToolSegmentContent(item, false)
    assert.deepEqual(open.map((entry) => [entry.kind, entry.id]), [
      ['block', 'block-read-1'],
      ['block', 'thinking-1'],
      ['block', 'block-read-2'],
      ['block', 'thinking-2'],
    ])
    const merged = open[3]?.kind === 'block' ? open[3].block : null
    assert.equal(merged?.kind === 'thinking' ? merged.durationMs : null, 500)
  })

  it('用户消息是硬边界，不把两个 turn 的工具混为一批', () => {
    const result = presentToolBatches([
      tool('tool-1', 'ReadFile'),
      { kind: 'user', id: 'user-2', text: '继续' },
      tool('tool-2', 'Grep'),
      text('text-2', '完成'),
    ])
    assert.deepEqual(result.map((item) => [item.kind, item.id]), [
      ['tool-segment', 'tool-batch-tool-1'],
      ['block', 'user-2'],
      ['tool-segment', 'tool-batch-tool-2'],
      ['block', 'text-2'],
    ])
    assert.equal(result[0]?.kind === 'tool-segment' ? result[0].sealed : null, false)
    assert.equal(result[2]?.kind === 'tool-segment' ? result[2].sealed : null, true)
  })

  it('按编辑、命令、其它的优先级生成摘要', () => {
    const batch = makeBatch([
      tool('edit', 'EditFile'),
      tool('run', 'RunCommand'),
      tool('read', 'ReadFile'),
    ])
    assert.deepEqual(summarizeToolBatch(batch), {
      label: '编辑了文件运行了命令并调用了工具',
      icon: 'files',
    })
  })

  it('覆盖各类组合的中文摘要和最高优先级图标', () => {
    const cases: Array<[string[], string, string]> = [
      [['WriteFile'], '编辑了文件', 'files'],
      [['RunCommand'], '运行了命令', 'command'],
      [['ReadFile'], '调用了工具', 'other'],
      [['EditFile', 'RunCommand'], '编辑了文件并运行了命令', 'files'],
      [['DeleteFile', 'Glob'], '编辑了文件并调用了工具', 'files'],
      [['RunCommand', 'Grep'], '运行了命令并调用了工具', 'command'],
    ]
    for (const [names, label, icon] of cases) {
      const summary = summarizeToolBatch(makeBatch(names.map((name, index) =>
        tool(`tool-${index}`, name))))
      assert.equal(summary.label, label)
      assert.equal(summary.icon, icon)
    }
  })

  it('把多文件编辑拆成独立行并匹配逐文件统计', () => {
    const edit = tool('edit', 'EditFile', {
      edits: [
        { path: 'src/a.ts', oldText: 'a', newText: 'b' },
        { path: 'src/b.ts', oldText: 'a', newText: 'b' },
      ],
    })
    edit.call.fileChanges = [
      { path: 'src/a.ts', added: 2, removed: 1 },
      { path: 'src/b.ts', added: 5, removed: 0 },
    ]
    const rows = toolBatchRows(makeBatch([edit]), {
      skills: [],
      projectDir: null,
      checkpointRestoreAnchorIds: new Set(['edit']),
    })
    assert.deepEqual(rows.map((row) => ({
      summary: row.summary,
      fullPath: row.fullPath,
      added: row.added,
      removed: row.removed,
      checkpointAnchor: row.checkpointAnchor,
    })), [
      {
        summary: 'a.ts',
        fullPath: 'src/a.ts',
        added: 2,
        removed: 1,
        checkpointAnchor: true,
      },
      {
        summary: 'b.ts',
        fullPath: 'src/b.ts',
        added: 5,
        removed: 0,
        checkpointAnchor: false,
      },
    ])
  })

  it('长路径不经摘要截断，仍能匹配统计并只展示文件名', () => {
    const fullPath = `C:\\workspace\\${'deep-folder\\'.repeat(18)}component.tsx`
    const write = tool('write', 'WriteFile', { path: fullPath, content: 'next' })
    write.call.fileChanges = [{ path: fullPath, added: 7, removed: 3 }]

    const [row] = toolBatchRows(makeBatch([write]), {
      skills: [],
      projectDir: 'E:\\Agent\\WhyCode',
      checkpointRestoreAnchorIds: new Set(),
    })
    assert.equal(fullPath.length > 180, true)
    assert.deepEqual(row, {
      id: 'tool-batch-write:row:write:0',
      call: write.call,
      summary: 'component.tsx',
      fullPath,
      added: 7,
      removed: 3,
      checkpointAnchor: false,
    })
  })

  it('相对文件名的悬浮路径按当前项目目录解析', () => {
    const edit = tool('edit-relative', 'EditFile', {
      edits: [{ path: '.\\hello.txt', oldText: '你好', newText: 'ok' }],
    })
    edit.call.fileChanges = [{ path: '.\\hello.txt', added: 1, removed: 1 }]

    const [row] = toolBatchRows(makeBatch([edit]), {
      skills: [],
      projectDir: 'C:\\Users\\Administrator\\Documents\\WhyCode Workspace\\session-id',
      checkpointRestoreAnchorIds: new Set(),
    })
    assert.equal(row?.summary, 'hello.txt')
    assert.equal(
      row?.fullPath,
      'C:\\Users\\Administrator\\Documents\\WhyCode Workspace\\session-id\\hello.txt',
    )
    assert.equal(row?.added, 1)
    assert.equal(row?.removed, 1)
  })
})

function text(id: string, value: string): Extract<Block, { kind: 'text' }> {
  return { kind: 'text', id, text: value, phase: 'activity' }
}

function thinking(
  id: string,
  value: string,
  durationMs: number | null,
): Extract<Block, { kind: 'thinking' }> {
  return { kind: 'thinking', id, text: value, durationMs }
}

function tool(
  id: string,
  name: string,
  input: unknown = {},
): Extract<Block, { kind: 'tool' }> {
  return {
    kind: 'tool',
    id: `block-${id}`,
    call: { id, name, input, status: 'done', progress: '', result: 'ok' },
  }
}

function makeBatch(tools: Extract<Block, { kind: 'tool' }>[]): ToolBatch {
  return { id: `tool-batch-${tools[0]!.call.id}`, tools }
}
