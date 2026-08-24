import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SubagentSummary } from '@whycode/core'
import {
  isSubagentRunning,
  resolveSubagentPanelPage,
  subagentProfileLabel,
  subagentStatusLabel,
} from './subagent-presentation.ts'

describe('子代理状态展示', () => {
  it('只把真实运行态归入正在进行，其余终态保留准确文案', () => {
    assert.equal(isSubagentRunning('running'), true)
    for (const status of ['completed', 'error', 'aborted', 'limit', 'refusal'] as const) {
      assert.equal(isSubagentRunning(status), false)
    }
    assert.equal(subagentStatusLabel('completed'), '已完成')
    assert.equal(subagentStatusLabel('error'), '失败')
    assert.equal(subagentStatusLabel('aborted'), '已停止')
    assert.equal(subagentStatusLabel('limit'), '达到上限')
    assert.equal(subagentStatusLabel('refusal'), '已拒绝')
    assert.equal(subagentProfileLabel('explore'), 'Explore')
    assert.equal(subagentProfileLabel('reviewer'), 'Reviewer')
    assert.equal(subagentProfileLabel('general'), 'General')
  })

  it('只在有效页面标题存在时解析对应正文', () => {
    const subagent: SubagentSummary = {
      id: 'agent-1',
      parentSessionId: 'parent-1',
      name: '通用代理',
      description: '测试代理',
      profile: 'general',
      status: 'completed',
      activationCount: 1,
      createdAt: '2026-08-21T00:00:00.000Z',
      updatedAt: '2026-08-21T00:00:01.000Z',
      startedAt: '2026-08-21T00:00:00.000Z',
      endedAt: '2026-08-21T00:00:01.000Z',
    }

    assert.equal(resolveSubagentPanelPage(null, [subagent]), null)
    assert.deepEqual(resolveSubagentPanelPage({ kind: 'overview' }, [subagent]), {
      kind: 'overview',
      title: '子代理',
    })
    assert.deepEqual(
      resolveSubagentPanelPage({ kind: 'transcript', subagentId: subagent.id }, [subagent]),
      { kind: 'transcript', title: '通用代理', subagent },
    )
    assert.equal(
      resolveSubagentPanelPage({ kind: 'transcript', subagentId: 'missing' }, [subagent]),
      null,
    )
  })
})
