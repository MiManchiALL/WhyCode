import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import { emptyTaskPlanState } from '../tasks/types.ts'
import { buildLoadedSession, SessionCorruptError } from './chain.ts'
import { SESSION_SCHEMA_VERSION, sessionEntrySchema, type SessionEntry } from './types.ts'

describe('编辑与根输入身份校验', () => {
  it('拒绝用其它物理分支的根输入确认 turn-start', () => {
    const fixture = createFixture()
    const firstRoot = fixture.entry({
      type: 'user-input',
      parentUuid: fixture.start.uuid,
      text: '分支一',
      startsTurn: true,
    })
    const secondRoot = fixture.entry({
      type: 'user-input',
      parentUuid: fixture.start.uuid,
      text: '分支二',
      startsTurn: true,
    })
    const started = fixture.entry({
      type: 'turn-start',
      parentUuid: secondRoot.uuid,
      turnId: 'turn-cross-branch',
      engagedPlanId: null,
      rootInputId: firstRoot.uuid,
    })

    assert.throws(
      () => buildLoadedSession([fixture.start, firstRoot, secondRoot, started]),
      SessionCorruptError,
    )
  })

  it('拒绝引用不存在旧回合的编辑输入', () => {
    const fixture = createFixture()
    const snapshot = fixture.entry({
      type: 'snapshot',
      parentUuid: null,
      reason: 'rollback',
      activeTurnId: null,
      activeTurnEngagedPlanId: null,
      activeConsensusTaskId: null,
      activeConsensusBaseMessages: null,
      activeConsensusBaseTaskState: null,
      activeConsensusBaseTurnIds: null,
      consensusState: null,
      taskState: emptyTaskPlanState(),
      modelId: 'test:model',
      reasoningEffort: 'default',
      messages: [],
      pendingUserInputs: [],
      turnStartMessages: [],
    })
    const edited = fixture.entry({
      type: 'user-input',
      parentUuid: snapshot.uuid,
      text: '编辑后',
      startsTurn: true,
      replacesTurnId: 'missing-turn',
    })

    assert.throws(
      () => buildLoadedSession([fixture.start, snapshot, edited]),
      SessionCorruptError,
    )
  })
})

function createFixture(): {
  start: SessionEntry
  entry: (value: Record<string, unknown>) => SessionEntry
} {
  const sessionId = randomUUID()
  const entry = (value: Record<string, unknown>) => sessionEntrySchema.parse({
    schemaVersion: SESSION_SCHEMA_VERSION,
    sessionId,
    uuid: randomUUID(),
    parentUuid: null,
    timestamp: new Date().toISOString(),
    ...value,
  })
  return {
    start: entry({
      type: 'session-start',
      projectDir: 'C:\\WhyCode',
      modelId: 'test:model',
    }),
    entry,
  }
}
