import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import type { SubagentManifest } from '@whycode/core'
import {
  completedSubagentActivationDurationMs,
  subagentSummary,
} from './subagent-record.ts'

describe('子代理时长投影', () => {
  it('只累计已结束 activation，并把当前轮次留给 Renderer 实时补入', () => {
    const manifest = fixture()

    assert.equal(completedSubagentActivationDurationMs(manifest.activations[0]!), 5_000)
    assert.equal(completedSubagentActivationDurationMs(manifest.activations[1]!), 0)
    assert.equal(subagentSummary(manifest).completedDurationMs, 5_000)
  })
})

function fixture(): SubagentManifest {
  const parentSessionId = randomUUID()
  const subagentId = randomUUID()
  return {
    schemaVersion: 2,
    id: subagentId,
    parentSessionId,
    createdByTurnId: 'turn-1',
    createdByToolCallId: 'tool-1',
    taskDescription: '检查计时事实',
    definition: {
      id: 'explore',
      name: '探索代理',
      description: '只读调查',
      profile: 'explore',
      scope: 'builtin',
      instructions: '读取证据。',
      toolNames: ['ReadFile'],
    },
    modelId: 'test:model',
    reasoningEffort: 'default',
    permission: {
      mode: 'default',
      additionalDirs: [],
      sessionAllowedTools: [],
    },
    createdAt: '2026-08-21T08:00:00.000Z',
    updatedAt: '2026-08-21T08:00:12.000Z',
    activations: [{
      id: randomUUID(),
      sequence: 1,
      parentTurnId: 'turn-1',
      parentToolCallId: 'tool-1',
      promptPreview: '第一次检查',
      startedAt: '2026-08-21T08:00:00.000Z',
      endedAt: '2026-08-21T08:00:05.000Z',
      outcome: 'completed',
      resultText: '完成。',
      settlement: 'delivered',
    }, {
      id: randomUUID(),
      sequence: 2,
      parentTurnId: 'turn-2',
      parentToolCallId: 'tool-2',
      promptPreview: '继续检查',
      startedAt: '2026-08-21T08:00:12.000Z',
    }],
  }
}
