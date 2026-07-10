import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { extractMemorySummary } from './memory.ts'
import { consensusPersistedStateSchema, type ProtocolOutput } from './types.ts'

describe('协商跨任务记忆', () => {
  it('不持久化只在当次任务有效的 scratch 路径', () => {
    const output: ProtocolOutput = {
      agentId: 'B',
      round: 1,
      candidate: {
        summary: '采用输入校验方案',
        finalAnswerOrPlan: '先验证输入，再执行写入。',
        scratchArtifacts: ['C:\\scratch\\task-1\\B\\probe.txt'],
      },
      votes: [],
    }

    const memory = extractMemorySummary('B', 'task-1', [output])

    assert.equal('scratchArtifacts' in memory, false)
  })

  it('恢复旧会话时丢弃历史状态中的 scratch 路径', () => {
    const parsed = consensusPersistedStateSchema.parse({
      taskCounter: 1,
      sessionScore: { Main: 0, B: 0, C: 0 },
      memories: {
        B: [
          {
            agentId: 'B',
            taskId: 'task-1',
            stance: '旧结论',
            supportedCandidates: [],
            rejectedCandidates: [],
            importantSuggestions: [],
            evidenceRefs: [],
            scratchArtifacts: ['C:\\scratch\\stale.txt'],
          },
        ],
        C: [],
      },
      taskLog: [],
    })

    assert.equal('scratchArtifacts' in parsed.memories.B[0]!, false)
  })
})
