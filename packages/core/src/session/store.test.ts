import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { access, appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import type { ModelMessage } from 'ai'
import type { ImageAttachment } from '../attachments/types.ts'
import type { ConsensusPersistedState } from '../consensus/types.ts'
import {
  createUserQuestionMarker,
  hasPendingUserQuestion,
} from '../tasks/answer-resume.ts'
import {
  activeTaskPlanSchema,
  type ActiveTaskPlan,
  type TaskPlanState,
} from '../tasks/types.ts'
import { buildLoadedSession, parseTranscript, SessionCorruptError } from './chain.ts'
import { createTurnAbortedMessage, isTurnAbortedMessage } from './interruption.ts'
import { getSessionPaths } from './metadata.ts'
import { SessionStore } from './store.ts'
import { SESSION_SCHEMA_VERSION, sessionEntrySchema } from './types.ts'
import {
  isProjectInstructionsMessage,
  loadProjectInstructions,
} from '../instructions/project.ts'
import { localWorkspace } from '../workspace/types.ts'
import type { ActivatedSkill } from '../skills/types.ts'
import { skillContentDigest, skillId } from '../skills/parser.ts'

const tempRoots: string[] = []
const storeRoots = new WeakMap<SessionStore, string>()

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('SessionStore', () => {
  it('最新根消息编辑从根输入恢复完整 Skill 快照', async () => {
    const store = await createStore()
    const journal = await store.create({
      workspace: localWorkspace('C:\\work\\skill-edit'),
      modelId: 'test:model',
    })
    const skill = activatedSkillFixture()
    const inputId = randomUUID()
    const turnId = randomUUID()
    await journal.recordUserInputWithId(inputId, '原问题', true, [], [], [], [skill])
    await journal.recordTurnStart(
      turnId,
      [{ role: 'user', content: '原问题' }],
      undefined,
      [],
      undefined,
      inputId,
      [skill],
    )
    await journal.recordViewEvents([
      { type: 'core-event', event: { type: 'turn-start', turnId } },
    ])
    await journal.recordTurnEnd(turnId, 'aborted')

    const reopened = await store.open(journal.sessionId)
    const recoveredSkills = reopened.skillsForTurn(turnId)
    const rollbackMessages = reopened.messagesBeforeTurn(turnId)
    const rollbackTaskState = reopened.taskStateBeforeTurn(turnId)
    assert.deepEqual(recoveredSkills, [skill])
    assert.notEqual(rollbackMessages, null)
    assert.notEqual(rollbackTaskState, undefined)

    const editedInputId = randomUUID()
    await reopened.recordTurnEditInput(
      turnId,
      editedInputId,
      '编辑后的问题',
      rollbackMessages!,
      rollbackTaskState!,
      [],
      [],
      recoveredSkills!,
    )
    const transcript = join(storeRoots.get(store)!, journal.sessionId, 'transcript.jsonl')
    const entries = parseTranscript(await readFile(transcript, 'utf8'))
    const editedInput = entries.find((entry) =>
      entry.type === 'user-input' && entry.uuid === editedInputId)
    assert.equal(editedInput?.type, 'user-input')
    if (editedInput?.type !== 'user-input') throw new Error('编辑输入未落盘')
    assert.deepEqual(editedInput.skills, [skill])

    const original = await readFile(transcript, 'utf8')
    await writeFile(transcript, original.replaceAll('VERIFY_BODY', 'TAMPERED_BODY'), 'utf8')
    await assert.rejects(store.open(journal.sessionId), /Skill 快照正文摘要不匹配/)
  })

  it('完整 Skill 快照随排队、恢复、重提和重启保持同一语义', async () => {
    const store = await createStore()
    const journal = await store.create({
      workspace: localWorkspace('C:\\work\\skill-project'),
      modelId: 'test:model',
    })
    const queuedId = randomUUID()
    const skill = activatedSkillFixture()
    await journal.recordUserInputWithId(queuedId, '按流程检查', false, [], [], [], [skill])

    const queued = await store.open(journal.sessionId)
    assert.deepEqual(queued.pendingUserInputs, [{
      id: queuedId,
      text: '按流程检查',
      skills: [skill],
      state: 'queued',
    }])

    await queued.markUserInputsRestored([queuedId])
    const restored = await store.open(journal.sessionId)
    assert.deepEqual(restored.pendingUserInputs[0]?.skills, [skill])
    assert.equal(restored.pendingUserInputs[0]?.state, 'restored')

    const replacementId = randomUUID()
    await restored.recordUserInputWithId(
      replacementId,
      '按流程检查',
      true,
      [],
      [queuedId],
      [],
      [skill],
    )
    const reopened = await store.open(journal.sessionId)
    assert.deepEqual(reopened.pendingUserInputs, [])
    assert.deepEqual(
      reopened.initialViewEvents.find((event) =>
        event.type === 'user-message' && event.inputId === replacementId),
      {
        type: 'user-message',
        inputId: replacementId,
        text: '按流程检查',
        startsTurn: true,
        skills: [{
          id: skill.id,
          path: skill.path,
          rootPath: skill.rootPath,
          name: skill.name,
          description: skill.description,
          scope: skill.scope,
        }],
      },
    )
  })

  it('排队根和共识最终执行在重启后恢复起点聚合的 Skill 快照', async () => {
    const store = await createStore()
    const journal = await store.create({
      workspace: localWorkspace('C:\\work\\skill-consensus'),
      modelId: 'test:model',
    })
    const rootSkill = activatedSkillFixture()
    const steeringContent = '---\nname: second\ndescription: 第二项\n---\nSECOND_BODY'
    const steeringPath = 'C:\\work\\skill-project\\.agents\\skills\\second\\SKILL.md'
    const steeringSkill: ActivatedSkill = {
      ...activatedSkillFixture(),
      id: skillId(steeringPath),
      path: steeringPath,
      rootPath: 'C:\\work\\skill-project\\.agents\\skills\\second',
      name: 'second',
      description: '第二项',
      digest: skillContentDigest(steeringContent),
      content: steeringContent,
    }
    const rootInputId = randomUUID()
    await journal.recordUserInputWithId(
      rootInputId,
      '共识根任务',
      true,
      [],
      [],
      [],
      [rootSkill],
    )
    await journal.recordConsensusTaskStart(
      'task-skills',
      consensusState(1),
      '共识根任务',
      [],
      [rootSkill],
    )
    const discussionTurnId = randomUUID()
    await journal.recordTurnStart(
      discussionTurnId,
      [message('user', '生成 M1')],
    )
    assert.deepEqual(journal.skillsForTurn(discussionTurnId), [rootSkill])
    await journal.recordTurnEnd(discussionTurnId, 'completed')
    const steeringInputId = randomUUID()
    await journal.recordUserInputWithId(
      steeringInputId,
      '补充第二流程',
      false,
      [],
      [],
      [],
      [steeringSkill],
    )
    const turnId = randomUUID()
    await journal.recordTurnStart(
      turnId,
      [message('user', '执行共识结果')],
      undefined,
      [steeringInputId],
      undefined,
      undefined,
      [rootSkill, steeringSkill],
    )
    await journal.recordTurnEnd(turnId, 'completed')
    await journal.recordConsensusTaskEnd(
      'task-skills',
      'completed',
      consensusState(1),
    )
    const queuedInputId = randomUUID()
    await journal.recordUserInputWithId(
      queuedInputId,
      '下一排队根',
      false,
      [],
      [],
      [],
      [steeringSkill],
    )
    const queuedTurnId = randomUUID()
    await journal.recordTurnStart(
      queuedTurnId,
      [message('user', '下一排队根')],
      undefined,
      [queuedInputId],
      undefined,
      undefined,
      [steeringSkill],
    )
    await journal.recordTurnEnd(queuedTurnId, 'aborted')

    const reopened = await store.open(journal.sessionId)
    assert.deepEqual(reopened.skillsForTurn(discussionTurnId), [rootSkill])
    assert.deepEqual(reopened.skillsForTurn(turnId), [rootSkill, steeringSkill])
    assert.deepEqual(reopened.skillsForTurn(queuedTurnId), [steeringSkill])
  })
  it('自定义 System 只在会话起点固化，并跨压缩恢复同一快照', async () => {
    const store = await createStore()
    const journal = await store.create({
      workspace: localWorkspace('C:\\work\\demo'),
      modelId: 'test:model',
      customSystemPrompt: {
        mode: 'append',
        content: '始终先验证再回答。\r\n',
      },
    })
    await journal.recordSnapshot('compact', [])

    const reopened = await store.open(journal.sessionId)
    assert.deepEqual(reopened.customSystemPrompt, {
      mode: 'append',
      content: '始终先验证再回答。\r\n',
    })

    const transcript = join(
      storeRoots.get(store)!,
      journal.sessionId,
      'transcript.jsonl',
    )
    const entries = parseTranscript(await readFile(transcript, 'utf8'))
    assert.deepEqual(
      entries.find((entry) => entry.type === 'session-start')?.customSystemPrompt,
      reopened.customSystemPrompt,
    )
    assert.equal(
      entries.some((entry) =>
        entry.type === 'snapshot' && Object.hasOwn(entry, 'customSystemPrompt')),
      false,
    )
  })

  it('项目指令版本以审计事件追加，活动消息和 turn 锚点只保留最新版本', async () => {
    const store = await createStore()
    const project = join(storeRoots.get(store)!, 'project')
    await mkdir(project, { recursive: true })
    await writeFile(join(project, 'AGENTS.md'), '第一版规则', 'utf8')
    const first = await loadProjectInstructions({ projectDir: project })
    assert.ok(first)
    const journal = await store.create({ workspace: localWorkspace(project), modelId: 'test:model' })
    await journal.recordUserInput('开始任务', true)
    await journal.recordTurnStart(
      'turn-project-instructions',
      [message('user', '开始任务')],
      undefined,
      [],
      { version: first.version, message: first.message },
    )
    await journal.recordStep(
      'turn-project-instructions',
      [message('assistant', '处理中')],
    )

    await writeFile(join(project, 'AGENTS.md'), '第二版规则', 'utf8')
    const second = await loadProjectInstructions({ projectDir: project })
    assert.ok(second)
    await journal.recordProjectInstructions({
      version: second.version,
      message: second.message,
    })

    const reopened = await store.open(journal.sessionId)
    assert.equal(reopened.undeliveredUserInputIds.length, 0)
    assert.equal(reopened.initialMessages.filter(isProjectInstructionsMessage).length, 1)
    assert.equal(reopened.initialMessages[0] && modelText(reopened.initialMessages[0]), modelText(second.message))
    assert.deepEqual(
      reopened.messagesBeforeTurn('turn-project-instructions')?.map(modelText),
      [modelText(second.message)],
    )
    const transcript = join(
      storeRoots.get(store)!,
      journal.sessionId,
      'transcript.jsonl',
    )
    const instructionEvents = parseTranscript(await readFile(transcript, 'utf8'))
      .filter((entry) => entry.type === 'project-instructions')
    assert.deepEqual(instructionEvents.map((entry) => entry.version), [
      first.version,
      second.version,
    ])

    await reopened.recordProjectInstructions({ version: null, message: null })
    const removed = await store.open(journal.sessionId)
    assert.equal(removed.initialMessages.some(isProjectInstructionsMessage), false)
    assert.deepEqual(
      removed.messagesBeforeTurn('turn-project-instructions'),
      [],
    )
  })

  it('项目指令变化会同步替换活动共识的回滚基线', async () => {
    const store = await createStore()
    const project = join(storeRoots.get(store)!, 'consensus-project')
    await mkdir(project, { recursive: true })
    const instructionPath = join(project, 'AGENTS.md')
    await writeFile(instructionPath, '共识规则一', 'utf8')
    const first = await loadProjectInstructions({ projectDir: project })
    assert.ok(first)
    const journal = await store.create({ workspace: localWorkspace(project), modelId: 'test:model' })
    await journal.recordProjectInstructions({
      version: first.version,
      message: first.message,
    })
    const state = consensusState(1)
    await journal.recordConsensusTaskStart('instruction-consensus', state, '讨论当前方案')

    await writeFile(instructionPath, '共识规则二', 'utf8')
    const second = await loadProjectInstructions({ projectDir: project })
    assert.ok(second)
    await journal.recordProjectInstructions({
      version: second.version,
      message: second.message,
    })
    await journal.recordConsensusTaskEnd('instruction-consensus', 'aborted', state)

    const reopened = await store.open(journal.sessionId)
    const active = JSON.stringify(reopened.initialMessages)
    assert.equal(reopened.initialMessages.filter(isProjectInstructionsMessage).length, 1)
    assert.match(active, /共识规则二/)
    assert.doesNotMatch(active, /共识规则一/)
  })

  it('按稳定 turn 边界持久化并恢复消息', async () => {
    const store = await createStore()
    const journal = await store.create({ workspace: localWorkspace('C:\\work\\demo'), modelId: 'test:model' })
    const user = message('user', '修复登录问题')
    const assistant = message('assistant', '已经完成')

    await journal.recordUserInput('修复登录问题', true)
    await journal.recordTurnStart('turn-1', [user])
    await journal.recordStep('turn-1', [assistant])
    await journal.recordTurnEnd('turn-1', 'completed')

    const reopened = await store.open(journal.sessionId)
    assert.deepEqual(reopened.initialMessages, [user, assistant])
    assert.equal(reopened.interruptedTurnId, null)
    assert.equal(reopened.metadataSnapshot.title, '修复登录问题')
    assert.equal(reopened.metadataSnapshot.status, 'idle')
    assert.deepEqual(reopened.messagesBeforeTurn('turn-1'), [])
  })

  it('steering 队列跨快照保留，并以模型消息批次原子确认送达', async () => {
    const store = await createStore()
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    const rootInputId = randomUUID()
    await journal.recordUserInputWithId(rootInputId, '开始', true)
    await journal.recordTurnStart(
      'turn-queue',
      [message('user', '开始')],
      undefined,
      [],
      undefined,
      rootInputId,
    )
    const firstId = randomUUID()
    const secondId = randomUUID()
    await journal.recordUserInputWithId(firstId, '第一条插话', false)
    await journal.recordUserInputWithId(secondId, '第二条插话', false)
    await journal.recordSnapshot('compact', [...journal.initialMessages], 'turn-queue')

    const queued = await store.open(journal.sessionId)
    assert.deepEqual(queued.pendingUserInputs.map(({ id, text, state }) => ({ id, text, state })), [
      { id: firstId, text: '第一条插话', state: 'queued' },
      { id: secondId, text: '第二条插话', state: 'queued' },
    ])
    await queued.recordStep(
      'turn-queue',
      [message('user', '第一条插话'), message('user', '第二条插话')],
      undefined,
      undefined,
      { deliveredInputIds: [firstId, secondId] },
    )

    const delivered = await store.open(journal.sessionId)
    assert.deepEqual(delivered.pendingUserInputs, [])
    assert.deepEqual(delivered.initialMessages.map(modelText), ['开始', '第一条插话', '第二条插话'])
  })

  it('送达确认后崩溃缺失即时事件时，在原交付位置补回 steering 时间线', async () => {
    const store = await createStore()
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    const rootInputId = randomUUID()
    await journal.recordUserInputWithId(rootInputId, '开始', true)
    await journal.recordTurnStart('turn-visible-steering', [message('user', '开始')])
    const inputId = randomUUID()
    await journal.recordUserInputWithId(inputId, '交付后即崩溃的插话', false)
    await journal.recordStep(
      'turn-visible-steering',
      [message('user', '交付后即崩溃的插话')],
      undefined,
      undefined,
      { deliveredInputIds: [inputId] },
    )
    // 模拟 messages 已写稳、message-injected 尚未来得及写入，重启后又产生了更新事件。
    await journal.recordViewEvents([{
      type: 'core-event',
      event: { type: 'text-delta', text: '后续稳定事件' },
    }])

    const reopened = await store.open(journal.sessionId)
    assert.deepEqual(reopened.initialViewEvents, [
      { type: 'user-message', inputId: rootInputId, text: '开始', startsTurn: true },
      {
        type: 'user-message',
        inputId,
        text: '交付后即崩溃的插话',
        startsTurn: false,
      },
      { type: 'core-event', event: { type: 'text-delta', text: '后续稳定事件' } },
    ])
    assert.equal(reopened.initialViewEventTimestamps.length, reopened.initialViewEvents.length)
    for (const timestamp of reopened.initialViewEventTimestamps) {
      assert.equal(Number.isNaN(Date.parse(timestamp)), false)
    }
  })

  it('停止时把 steering 原子退回草稿，重新提交只消费当前会话的恢复身份', async () => {
    const store = await createStore()
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    const queuedId = randomUUID()
    await journal.recordUserInputWithId(queuedId, '原始草稿', false)
    await journal.markUserInputsRestored([queuedId])

    const restored = await store.open(journal.sessionId)
    assert.equal(restored.pendingUserInputs[0]?.state, 'restored')
    await assert.rejects(
      restored.recordUserInputWithId(randomUUID(), '无效提交', true, [], [randomUUID()]),
      /无法消费不属于当前会话/,
    )
    const replacementId = randomUUID()
    await restored.recordUserInputWithId(
      replacementId,
      '编辑后的草稿',
      true,
      [],
      [queuedId],
    )

    const reopened = await store.open(journal.sessionId)
    assert.deepEqual(reopened.pendingUserInputs, [])
    assert.deepEqual(reopened.undeliveredUserInputIds, [replacementId])
  })

  it('进程中断把尚未送达的 steering 恢复为草稿而不注入模型历史', async () => {
    const store = await createStore()
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    await journal.recordUserInput('开始', true)
    await journal.recordTurnStart('turn-crash-queue', [message('user', '开始')])
    const inputId = randomUUID()
    await journal.recordUserInputWithId(inputId, '崩溃前插话', false)

    const interrupted = await store.open(journal.sessionId)
    await interrupted.recoverInterruptedWork()
    const recovered = await store.open(journal.sessionId)
    assert.deepEqual(recovered.pendingUserInputs.map(({ id, text, state }) => ({ id, text, state })), [
      { id: inputId, text: '崩溃前插话', state: 'restored' },
    ])
    assert.equal(recovered.initialMessages.some((entry) => modelText(entry) === '崩溃前插话'), false)
  })

  it('附件元数据冲突在 JSONL 追加前失败', async () => {
    const store = await createStore()
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    const attachmentId = randomUUID()
    const attachment: ImageAttachment = {
      id: attachmentId,
      sessionId: journal.sessionId,
      name: 'original.png',
      storageName: `${attachmentId}.png`,
      mediaType: 'image/png',
      sha256: 'a'.repeat(64),
      byteLength: 100,
      width: 10,
      height: 10,
    }
    await journal.recordUserInputWithId(randomUUID(), '第一条', false, [attachment])
    const transcript = join(storeRoots.get(store)!, journal.sessionId, 'transcript.jsonl')
    const before = await readFile(transcript, 'utf8')

    await assert.rejects(
      journal.recordUserInputWithId(
        randomUUID(),
        '冲突条目',
        false,
        [{ ...attachment, name: 'conflict.png' }],
      ),
      /附件元数据冲突/,
    )
    assert.equal(await readFile(transcript, 'utf8'), before)
  })

  it('持久化等待用户状态和问题卡', async () => {
    const store = await createStore()
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    const question = {
      type: 'core-event' as const,
      event: {
        type: 'user-question' as const,
        question: {
          id: 'question-1',
          questions: [{
            header: '实现偏好',
            question: '你更看重哪一点？',
            options: [
              { label: '简单可靠', description: '减少复杂度' },
              { label: '功能完整', description: '覆盖更多场景' },
            ],
          }],
        },
      },
    }
    await journal.recordTurnStart('turn-question', [message('user', '帮我选择')])
    await journal.recordViewEvents([question])
    await journal.recordTurnEnd('turn-question', 'waiting-user')

    const reopened = await store.open(journal.sessionId)
    assert.equal(reopened.metadataSnapshot.status, 'waiting-user')
    assert.deepEqual(reopened.initialViewEvents, [question])
  })

  it('问题 step 已提交但 turn-end 前崩溃时，恢复后仍保持 waiting-user', async () => {
    const store = await createStore()
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    const question = {
      id: 'question-before-turn-end',
      questions: [{
        header: '运行系统',
        question: '你使用哪个系统？',
        options: [
          { label: 'Windows', description: '按 Windows 环境处理' },
          { label: 'macOS', description: '按 macOS 环境处理' },
        ],
      }],
    }
    await journal.recordTurnStart('turn-question-crash', [message('user', '继续配置')])
    await journal.recordStep(
      'turn-question-crash',
      [createUserQuestionMarker(question, false)],
    )

    const interrupted = await store.open(journal.sessionId)
    assert.equal(interrupted.metadataSnapshot.status, 'interrupted')
    await interrupted.recoverInterruptedWork()

    assert.equal(interrupted.metadataSnapshot.status, 'waiting-user')
    const reopened = await store.open(journal.sessionId)
    assert.equal(reopened.metadataSnapshot.status, 'waiting-user')
    assert.equal(hasPendingUserQuestion([...reopened.initialMessages]), true)
    assert.equal(
      reopened.initialViewEvents.some((entry) =>
        entry.type === 'core-event'
        && entry.event.type === 'user-question'
        && entry.event.question.id === question.id),
      true,
    )
  })

  it('尚未建立 turn 的根用户回答按中断输入恢复，不丢回答或重开问题卡', async () => {
    const { store, journal, questionEvent, answer } = await waitingQuestionSession()
    await journal.recordUserInput(answer, true)

    const interrupted = await store.open(journal.sessionId)
    assert.equal(interrupted.metadataSnapshot.status, 'interrupted')
    assert.equal(interrupted.undeliveredUserInputIds.length, 1)
    assert.deepEqual(interrupted.initialMessages.at(-1), message('user', answer))
    assert.equal(hasPendingUserQuestion([...interrupted.initialMessages]), false)
    assert.deepEqual(interrupted.initialViewEvents, [
      questionEvent,
      {
        type: 'user-message',
        inputId: interrupted.undeliveredUserInputIds[0],
        text: answer,
        startsTurn: true,
      },
    ])

    await interrupted.recoverInterruptedWork()
    const recovered = await store.open(journal.sessionId)
    assert.equal(recovered.metadataSnapshot.status, 'idle')
    assert.equal(recovered.undeliveredUserInputIds.length, 0)
    assert.deepEqual(recovered.initialMessages.at(-2), message('user', answer))
    assert.equal(isTurnAbortedMessage(recovered.initialMessages.at(-1)!), true)

    const restartedAgain = await store.open(journal.sessionId)
    assert.equal(restartedAgain.initialMessages.filter(isTurnAbortedMessage).length, 1)
    assert.equal(countMessage(restartedAgain.initialMessages, message('user', answer)), 1)
  })

  it('turn-start 已落而首批 messages 尾行截断时仍恢复根用户回答', async () => {
    const { store, journal, answer } = await waitingQuestionSession()
    await journal.recordUserInput(answer, true)
    const transcript = join(storeRoots.get(store)!, journal.sessionId, 'transcript.jsonl')
    const entries = (await readFile(transcript, 'utf8')).trimEnd().split('\n')
    const input = sessionEntrySchema.parse(JSON.parse(entries.at(-1)!))
    assert.equal(input.type, 'user-input')
    const partialTurn = sessionEntrySchema.parse({
      schemaVersion: SESSION_SCHEMA_VERSION,
      type: 'turn-start',
      sessionId: journal.sessionId,
      uuid: randomUUID(),
      parentUuid: input.uuid,
      timestamp: new Date().toISOString(),
      turnId: 'answer-partial-turn',
      engagedPlanId: null,
    })
    await appendFile(
      transcript,
      `${JSON.stringify(partialTurn)}\n{"schemaVersion":3,"type":"messages"`,
      'utf8',
    )

    const interrupted = await store.open(journal.sessionId)
    assert.equal(interrupted.interruptedTurnId, 'answer-partial-turn')
    assert.equal(interrupted.undeliveredUserInputIds.length, 1)
    assert.deepEqual(interrupted.initialMessages.at(-1), message('user', answer))
    assert.equal(interrupted.messagesBeforeTurn('answer-partial-turn'), null)
    assert.equal(hasPendingUserQuestion([...interrupted.initialMessages]), false)

    await interrupted.recoverInterruptedWork()
    const recovered = await store.open(journal.sessionId)
    assert.equal(recovered.interruptedTurnId, null)
    assert.equal(recovered.undeliveredUserInputIds.length, 0)
    assert.equal(countMessage(recovered.initialMessages, message('user', answer)), 1)
    assert.equal(recovered.initialMessages.filter(isTurnAbortedMessage).length, 1)
  })

  it('稳定 step 的消息、engagement 与 TaskPlanState 只以单条记录原子恢复', async () => {
    const store = await createStore()
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    const initialState = state(taskPlan(1))
    await journal.recordTurnStart('seed-plan', [message('user', '建立计划')])
    await journal.recordStep('seed-plan', [message('assistant', '计划已建立')], initialState)
    await journal.recordTurnEnd('seed-plan', 'paused')

    await journal.recordTurnStart('crashed-step', [message('user', '继续计划')])
    const advancedState = state(taskPlan(2))
    await journal.recordStep(
      'crashed-step',
      [message('assistant', '本步已完成 T1')],
      advancedState,
      advancedState.activePlan!.id,
    )
    const transcript = join(storeRoots.get(store)!, journal.sessionId, 'transcript.jsonl')
    const lines = (await readFile(transcript, 'utf8')).trimEnd().split('\n')
    const committedStep = lines.pop()!
    const parsedStep = JSON.parse(committedStep) as Record<string, unknown>
    assert.equal(parsedStep.type, 'messages')
    assert.ok(parsedStep.taskState)
    assert.equal(parsedStep.engagedPlanId, advancedState.activePlan!.id)
    await writeFile(
      transcript,
      `${lines.join('\n')}\n${committedStep.slice(0, Math.floor(committedStep.length / 2))}`,
      'utf8',
    )

    const recovered = await store.open(journal.sessionId)
    assert.deepEqual(recovered.initialTaskState, initialState)
    assert.equal(
      recovered.initialMessages.some((entry) =>
        entry.role === 'assistant' && entry.content === '本步已完成 T1'),
      false,
    )
    await recovered.recoverInterruptedWork()
    const restarted = await store.open(journal.sessionId)
    assert.deepEqual(restarted.initialTaskState, initialState)
  })

  it('完整回答 messages 落盘后只保留一份回答，旧问题卡保持关闭', async () => {
    const { store, journal, questionEvent, answer } = await waitingQuestionSession()
    await journal.recordUserInput(answer, true)
    const answerInputId = journal.undeliveredUserInputIds[0]!
    await journal.recordTurnStart('answer-complete-turn', [message('user', answer)])

    const interrupted = await store.open(journal.sessionId)
    assert.equal(interrupted.interruptedTurnId, 'answer-complete-turn')
    assert.equal(interrupted.undeliveredUserInputIds.length, 0)
    assert.equal(countMessage(interrupted.initialMessages, message('user', answer)), 1)
    assert.equal(hasPendingUserQuestion([...interrupted.initialMessages]), false)
    assert.deepEqual(interrupted.initialViewEvents, [
      questionEvent,
      { type: 'user-message', inputId: answerInputId, text: answer, startsTurn: true },
    ])

    await interrupted.recoverInterruptedWork()
    const recovered = await store.open(journal.sessionId)
    assert.equal(countMessage(recovered.initialMessages, message('user', answer)), 1)
    assert.equal(recovered.initialMessages.filter(isTurnAbortedMessage).length, 1)
  })

  it('连续根输入混合已交付与未交付状态时保持原始顺序', async () => {
    const store = await createStore()
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    await journal.recordUserInput('第一条未交付消息', true)
    await journal.recordUserInput('第二条已交付消息', true)
    await journal.recordTurnStart('second-turn', [message('user', '第二条已交付消息')])
    await journal.recordTurnEnd('second-turn', 'completed')

    const reopened = await store.open(journal.sessionId)
    assert.equal(journal.metadataSnapshot.status, 'interrupted')
    assert.equal(reopened.metadataSnapshot.status, journal.metadataSnapshot.status)
    assert.deepEqual(reopened.initialMessages, [
      message('user', '第一条未交付消息'),
      message('user', '第二条已交付消息'),
    ])
    assert.deepEqual(reopened.messagesBeforeTurn('second-turn'), [
      message('user', '第一条未交付消息'),
    ])
    assert.equal(reopened.undeliveredUserInputIds.length, 1)

    const consensusJournal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    await consensusJournal.recordUserInput('共识前未交付消息', true)
    await consensusJournal.recordUserInput('正式共识请求', true)
    await consensusJournal.recordConsensusTaskStart(
      'task-order',
      consensusState(1),
      '正式共识请求',
    )
    const consensusReopened = await store.open(consensusJournal.sessionId)
    assert.deepEqual(consensusReopened.initialMessages, [
      message('user', '共识前未交付消息'),
      message('user', '正式共识请求'),
    ])
    assert.equal(consensusReopened.undeliveredUserInputIds.length, 1)

    const lateJournal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    await lateJournal.recordUserInput('原始共识请求', true)
    await lateJournal.recordConsensusTaskStart(
      'task-late-input',
      consensusState(1),
      '原始共识请求',
    )
    await lateJournal.recordUserInput('共识起点后的未交付消息', true)
    const lateReopened = await store.open(lateJournal.sessionId)
    assert.deepEqual(lateReopened.initialMessages, [
      message('user', '原始共识请求'),
      message('user', '共识起点后的未交付消息'),
    ])
    assert.equal(lateReopened.undeliveredUserInputIds.length, 1)
  })

  it('文件和对话回滚到提问点后，重启会恢复待回答问题卡', async () => {
    const { store, journal, questionEvent, answer } = await waitingQuestionSession()
    const rollbackMessages = [...journal.initialMessages]
    await journal.recordUserInput(answer, true)
    await journal.recordTurnStart('answer-rollback-turn', [message('user', answer)])
    await journal.recordStep('answer-rollback-turn', [message('assistant', '继续执行并修改文件')])
    await journal.recordTurnEnd('answer-rollback-turn', 'completed')
    await journal.recordSnapshot('rollback', rollbackMessages)
    assert.equal(journal.metadataSnapshot.status, 'waiting-user')
    await journal.recordViewEvents([{
      type: 'core-event',
      event: {
        type: 'checkpoint-restored',
        toolUseId: 'tool-after-answer',
        turnId: 'answer-rollback-turn',
        scope: 'files-and-chat',
        ok: true,
      },
    }])

    const reopened = await store.open(journal.sessionId)
    assert.equal(hasPendingUserQuestion([...reopened.initialMessages]), true)
    assert.deepEqual(reopened.initialViewEvents.at(-1), questionEvent)
    assert.equal(
      reopened.initialViewEvents.filter((entry) =>
        entry.type === 'core-event' && entry.event.type === 'user-question').length,
      2,
    )
  })

  it('对话回滚离开提问点后清除 waiting-user 状态', async () => {
    const store = await createStore()
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    await journal.recordTurnStart('turn-question', [message('user', '帮我选择')])
    await journal.recordTurnEnd('turn-question', 'waiting-user')

    await journal.recordSnapshot('rollback', [])
    const reopened = await store.open(journal.sessionId)

    assert.equal(reopened.metadataSnapshot.status, 'idle')
  })

  it('恢复当前 schema 中缺失强度的会话时只将其解释为 default', async () => {
    const { store, journal, transcript } = await completedSession()
    const legacyLines = (await readFile(transcript, 'utf8')).trimEnd().split('\n').map((line) => {
      const entry = JSON.parse(line) as Record<string, unknown>
      delete entry.reasoningEffort
      return JSON.stringify(entry)
    })
    await writeFile(transcript, `${legacyLines.join('\n')}\n`, 'utf8')

    const reopened = await store.open(journal.sessionId)
    assert.equal(reopened.metadataSnapshot.reasoningEffort, 'default')
    assert.deepEqual(reopened.initialMessages, journal.initialMessages)
  })

  it('忽略崩溃留下的最后半行', async () => {
    const { store, journal, transcript } = await completedSession()
    await appendFile(transcript, '{"schemaVersion":1,"type":"messages"', 'utf8')

    const reopened = await store.open(journal.sessionId)
    assert.equal(reopened.initialMessages.length, 2)
    assert.equal(reopened.metadataSnapshot.status, 'idle')
  })

  it('完整末行缺少换行时先补分隔符，后续追加和重启不会粘行丢记录', async () => {
    const { store, journal, transcript } = await completedSession()
    const original = await readFile(transcript, 'utf8')
    assert.equal(original.endsWith('\n'), true)
    await writeFile(transcript, original.slice(0, -1), 'utf8')

    const repaired = await store.open(journal.sessionId)
    assert.equal((await readFile(transcript, 'utf8')).endsWith('\n'), true)
    await repaired.recordUserInput('修复后追加消息', true)
    await repaired.recordTurnStart('turn-after-repair', [message('user', '修复后追加消息')])
    await repaired.recordTurnEnd('turn-after-repair', 'completed')

    const reopened = await store.open(journal.sessionId)
    assert.deepEqual(reopened.initialMessages.at(-1), message('user', '修复后追加消息'))
    await reopened.updateModelSelection('test:after-repair', 'high')
    const restartedAgain = await store.open(journal.sessionId)
    assert.equal(restartedAgain.metadataSnapshot.modelId, 'test:after-repair')
    assert.equal(restartedAgain.metadataSnapshot.reasoningEffort, 'high')
    for (const line of (await readFile(transcript, 'utf8')).trimEnd().split('\n')) {
      assert.doesNotThrow(() => JSON.parse(line))
    }
  })

  it('最后一行 JSON 完整但结构非法时拒绝恢复', async () => {
    const { store, journal, transcript } = await completedSession()
    await appendFile(transcript, '{"schemaVersion":1}\n', 'utf8')

    await assert.rejects(store.open(journal.sessionId), /结构无效/)
  })

  it('拒绝中间损坏而不是静默拼错父链', async () => {
    const { store, journal, transcript } = await completedSession()
    const text = await readFile(transcript, 'utf8')
    const lines = text.trimEnd().split('\n')
    lines.splice(2, 0, '{bad-json')
    await writeFile(transcript, `${lines.join('\n')}\n`, 'utf8')

    await assert.rejects(store.open(journal.sessionId), SessionCorruptError)
  })

  it('把没有 turn-end 的会话标记为中断且不生成工具重放', async () => {
    const store = await createStore()
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    await journal.recordTurnStart('turn-crashed', [message('user', '继续执行')])
    const transcript = join(storeRoots.get(store)!, journal.sessionId, 'transcript.jsonl')
    await appendFile(transcript, '{"schemaVersion":3,"type":"messages"', 'utf8')

    const reopened = await store.open(journal.sessionId)
    assert.equal(reopened.interruptedTurnId, 'turn-crashed')
    assert.equal(reopened.metadataSnapshot.status, 'interrupted')
    assert.deepEqual(reopened.initialMessages, [message('user', '继续执行')])

    await reopened.recoverInterruptedWork()
    const recovered = await store.open(journal.sessionId)
    assert.equal(recovered.interruptedTurnId, null)
    assert.equal(recovered.initialMessages.some(isTurnAbortedMessage), true)
    assert.match(JSON.stringify(recovered.initialMessages), /process-interruption/)
    const restartedAgain = await store.open(journal.sessionId)
    assert.equal(restartedAgain.interruptedTurnId, null)
    assert.equal(restartedAgain.metadataSnapshot.status, 'idle')
  })

  it('进程恢复只阻塞被中断的 engaged 计划，不误伤 dormant 计划', async () => {
    const dormantStore = await createStore()
    const dormantJournal = await dormantStore.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    const plan = taskPlan(1)
    const savedState = state(plan)
    await dormantJournal.recordTurnStart('seed-dormant', [message('user', '建立计划')])
    await dormantJournal.recordStep('seed-dormant', [message('assistant', '计划已建立')], savedState)
    await dormantJournal.recordTurnEnd('seed-dormant', 'paused')
    await dormantJournal.recordTurnStart('dormant-question', [message('user', 'TTL 是什么')])

    const dormantCrash = await dormantStore.open(dormantJournal.sessionId)
    await dormantCrash.recoverInterruptedWork()
    const dormantRecovered = await dormantStore.open(dormantJournal.sessionId)
    assert.deepEqual(dormantRecovered.initialTaskState, savedState)

    const engagedStore = await createStore()
    const engagedJournal = await engagedStore.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    await engagedJournal.recordTurnStart('seed-engaged', [message('user', '建立计划')])
    await engagedJournal.recordStep('seed-engaged', [message('assistant', '计划已建立')], savedState)
    await engagedJournal.recordTurnEnd('seed-engaged', 'paused')
    await engagedJournal.recordTurnStart(
      'engaged-work',
      [message('user', '继续计划')],
      plan.id,
    )

    const engagedCrash = await engagedStore.open(engagedJournal.sessionId)
    await engagedCrash.recoverInterruptedWork()
    const engagedRecovered = await engagedStore.open(engagedJournal.sessionId)
    assert.equal(engagedRecovered.initialTaskState.resumeRequired, true)
    assert.equal(engagedRecovered.initialTaskState.interruptionReason, 'process-interruption')
  })

  it('连续中断恢复时总是在最新半截回合之后建立新边界', async () => {
    const store = await createStore()
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    await journal.recordTurnStart('turn-aborted', [message('user', '第一次任务')])
    await journal.recordStep('turn-aborted', [createTurnAbortedMessage()])
    await journal.recordTurnEnd('turn-aborted', 'aborted')
    await journal.recordTurnStart('turn-crashed', [message('user', '第二次任务')])

    const reopened = await store.open(journal.sessionId)
    await reopened.recoverInterruptedWork()
    const recovered = await store.open(journal.sessionId)
    const markers = recovered.initialMessages.filter(isTurnAbortedMessage)

    assert.equal(markers.length, 2)
    assert.match(JSON.stringify(markers.at(-1)), /process-interruption/)
    assert.equal(isTurnAbortedMessage(recovered.initialMessages.at(-1)!), true)
  })

  it('快照建立新根并丢弃旧活动链', async () => {
    const store = await createStore()
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    await journal.recordTurnStart('turn-1', [message('user', '旧问题')])
    await journal.recordStep('turn-1', [message('assistant', '旧答案')])
    await journal.recordTurnEnd('turn-1', 'completed')

    const summary = message('user', '压缩摘要')
    await journal.recordSnapshot('compact', [summary])
    await journal.recordTurnStart('turn-2', [message('user', '新问题')])
    await journal.recordStep('turn-2', [message('assistant', '新答案')])
    await journal.recordTurnEnd('turn-2', 'completed')

    const reopened = await store.open(journal.sessionId)
    assert.deepEqual(reopened.initialMessages, [
      summary,
      message('user', '新问题'),
      message('assistant', '新答案'),
    ])
    assert.equal(reopened.messagesBeforeTurn('turn-1'), null)
    assert.deepEqual(reopened.messagesBeforeTurn('turn-2'), [summary])
  })

  it('对话回滚换根后仍保留新根内更早 turn 的回滚边界', async () => {
    const store = await createStore()
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    const first = [message('user', '第一问'), message('assistant', '第一答')]
    await journal.recordTurnStart('turn-1', [first[0]!])
    await journal.recordStep('turn-1', [first[1]!])
    await journal.recordTurnEnd('turn-1', 'completed')
    await journal.recordTurnStart('turn-2', [message('user', '第二问')])
    await journal.recordStep('turn-2', [message('assistant', '第二答')])
    await journal.recordTurnEnd('turn-2', 'completed')

    await journal.recordSnapshot('rollback', first)
    const reopened = await store.open(journal.sessionId)
    assert.deepEqual(reopened.messagesBeforeTurn('turn-1'), [])
    assert.equal(reopened.messagesBeforeTurn('turn-2'), null)
  })

  it('编辑最新根消息时原子换根，重放保留原位关系且模型只续接新输入', async () => {
    const store = await createStore()
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    const oldInputId = randomUUID()
    await journal.recordUserInputWithId(oldInputId, '旧问题', true)
    await journal.recordTurnStart(
      'turn-old',
      [message('user', '旧问题')],
      undefined,
      [],
      undefined,
      oldInputId,
    )
    await journal.recordViewEvents([
      { type: 'core-event', event: { type: 'turn-start', turnId: 'turn-old' } },
    ])
    await journal.recordStep('turn-old', [createTurnAbortedMessage()])
    await journal.recordTurnEnd('turn-old', 'aborted')

    const rollbackMessages = journal.messagesBeforeTurn('turn-old')
    const rollbackTaskState = journal.taskStateBeforeTurn('turn-old')
    assert.notEqual(rollbackMessages, null)
    assert.notEqual(rollbackTaskState, undefined)
    const editedInputId = randomUUID()
    await journal.recordTurnEditInput(
      'turn-old',
      editedInputId,
      '编辑后的问题',
      rollbackMessages!,
      rollbackTaskState!,
    )

    const pending = await store.open(journal.sessionId)
    assert.deepEqual(pending.undeliveredUserInputIds, [editedInputId])
    assert.deepEqual(pending.initialMessages, [message('user', '编辑后的问题')])
    assert.equal(
      pending.initialViewEvents.some((entry) =>
        entry.type === 'core-event'
        && entry.event.type === 'user-message-edited'
        && entry.event.previousTurnId === 'turn-old'
        && entry.event.inputId === editedInputId),
      true,
    )

    await journal.recordTurnStart(
      'turn-edited',
      [message('user', '编辑后的问题')],
      undefined,
      [],
      undefined,
      editedInputId,
    )
    await journal.recordStep('turn-edited', [message('assistant', '新答案')])
    await journal.recordTurnEnd('turn-edited', 'completed')
    const reopened = await store.open(journal.sessionId)
    assert.deepEqual(reopened.initialMessages, [
      message('user', '编辑后的问题'),
      message('assistant', '新答案'),
    ])
    assert.equal(reopened.undeliveredUserInputIds.length, 0)
    const transcript = await readFile(
      join(storeRoots.get(store)!, journal.sessionId, 'transcript.jsonl'),
      'utf8',
    )
    assert.match(transcript, /旧问题/)
    assert.match(transcript, /编辑后的问题/)
  })

  it('协商内部后续 turn 不遮蔽根消息，编辑时恢复任务开始前的累计状态', async () => {
    const store = await createStore()
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    const rootInputId = randomUUID()
    const beforeTask = consensusState(2, '旧任务摘要')
    const afterTask = consensusState(3, '本任务摘要')
    await journal.recordUserInputWithId(rootInputId, '协商请求', true)
    await journal.recordConsensusTaskStart('task-3', beforeTask, '协商请求')

    await journal.recordTurnStart('turn-m1', [message('user', '生成 M1')])
    await journal.recordViewEvents([
      { type: 'core-event', event: { type: 'turn-start', turnId: 'turn-m1' } },
    ])
    await journal.recordStep('turn-m1', [message('assistant', 'M1')])
    await journal.recordTurnEnd('turn-m1', 'completed')
    await journal.recordTurnStart('turn-execute', [message('user', '执行最终方案')])
    await journal.recordViewEvents([
      { type: 'core-event', event: { type: 'turn-start', turnId: 'turn-execute' } },
    ])
    await journal.recordStep('turn-execute', [message('assistant', '旧答案')])
    await journal.recordTurnEnd('turn-execute', 'completed')
    await journal.recordConsensusTaskEnd('task-3', 'completed', afterTask)

    const reopened = await store.open(journal.sessionId)
    assert.deepEqual(reopened.consensusStateBeforeTurn('turn-m1'), beforeTask)
    const rollbackMessages = reopened.messagesBeforeTurn('turn-m1')
    const rollbackTaskState = reopened.taskStateBeforeTurn('turn-m1')
    assert.notEqual(rollbackMessages, null)
    assert.notEqual(rollbackTaskState, undefined)
    await reopened.recordTurnEditInput(
      'turn-m1',
      randomUUID(),
      '编辑后的协商请求',
      rollbackMessages!,
      rollbackTaskState!,
    )

    assert.deepEqual(reopened.initialConsensusState, beforeTask)
    const edited = await store.open(journal.sessionId)
    assert.deepEqual(edited.initialConsensusState, beforeTask)
    assert.deepEqual(edited.initialMessages, [message('user', '编辑后的协商请求')])
  })

  it('持久化边界拒绝编辑已有更新回合的旧根消息', async () => {
    const store = await createStore()
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    const firstInputId = randomUUID()
    await journal.recordUserInputWithId(firstInputId, '第一问', true)
    await journal.recordTurnStart(
      'turn-1',
      [message('user', '第一问')],
      undefined,
      [],
      undefined,
      firstInputId,
    )
    await journal.recordViewEvents([
      { type: 'core-event', event: { type: 'turn-start', turnId: 'turn-1' } },
    ])
    await journal.recordStep('turn-1', [message('assistant', '第一答')])
    await journal.recordTurnEnd('turn-1', 'completed')
    const secondInputId = randomUUID()
    await journal.recordUserInputWithId(secondInputId, '第二问', true)
    await journal.recordTurnStart(
      'turn-2',
      [message('user', '第二问')],
      undefined,
      [],
      undefined,
      secondInputId,
    )
    await journal.recordViewEvents([
      { type: 'core-event', event: { type: 'turn-start', turnId: 'turn-2' } },
    ])
    await journal.recordStep('turn-2', [message('assistant', '第二答')])
    await journal.recordTurnEnd('turn-2', 'completed')

    const rollbackMessages = journal.messagesBeforeTurn('turn-1')
    const rollbackTaskState = journal.taskStateBeforeTurn('turn-1')
    assert.notEqual(rollbackMessages, null)
    assert.notEqual(rollbackTaskState, undefined)
    await assert.rejects(
      journal.recordTurnEditInput(
        'turn-1',
        randomUUID(),
        '改写第一问',
        rollbackMessages!,
        rollbackTaskState!,
      ),
      /只能编辑最新一条用户消息/,
    )
  })

  it('模型压缩换根后仍完整保留用户可见时间线', async () => {
    const store = await createStore()
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    const visible = [
      { type: 'user-message' as const, text: '旧问题', startsTurn: true },
      { type: 'core-event' as const, event: { type: 'text-delta' as const, text: '旧回答' } },
    ]
    await journal.recordViewEvents(visible)
    await journal.recordSnapshot('compact', [message('user', '模型摘要')])
    await journal.recordViewEvents([
      { type: 'user-message', text: '新问题', startsTurn: true },
    ])

    const reopened = await store.open(journal.sessionId)
    assert.deepEqual(reopened.initialViewEvents, [
      ...visible,
      { type: 'user-message', text: '新问题', startsTurn: true },
    ])
    assert.deepEqual(reopened.initialMessages, [message('user', '模型摘要')])
  })

  it('自动压缩快照保留正在运行的 turn 标记', async () => {
    const store = await createStore()
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    const messages = [message('user', '需要压缩的请求')]
    await journal.recordTurnStart('turn-active', messages)
    await journal.recordSnapshot('compact', messages, 'turn-active')

    const reopened = await store.open(journal.sessionId)
    assert.equal(reopened.interruptedTurnId, 'turn-active')
  })

  it('Main 回合已结束但共识未结束时仍标记为中断', async () => {
    const store = await createStore()
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    const baseMessages = [message('user', '既有请求'), message('assistant', '既有回答')]
    await journal.recordTurnStart('base', [baseMessages[0]!])
    await journal.recordStep('base', [baseMessages[1]!])
    await journal.recordTurnEnd('base', 'completed')
    const state = consensusState(1)
    const consensusRequest = '讨论方案'
    await journal.recordConsensusTaskStart('task-1', state, consensusRequest)
    await journal.recordTurnStart('m1', [message('user', '讨论方案')])
    await journal.recordTurnEnd('m1', 'completed')

    const reopened = await store.open(journal.sessionId)
    assert.equal(reopened.interruptedTurnId, null)
    assert.equal(reopened.interruptedConsensusTaskId, 'task-1')
    assert.equal(reopened.metadataSnapshot.status, 'interrupted')
    assert.deepEqual(reopened.initialConsensusState, state)
    assert.deepEqual(reopened.initialMessages, [
      ...baseMessages,
      message('user', consensusRequest),
    ])
    assert.deepEqual(reopened.messagesBeforeTurn('base'), [])
    assert.equal(reopened.messagesBeforeTurn('m1'), null)

    await reopened.recoverInterruptedWork()
    const recovered = await store.open(journal.sessionId)
    assert.equal(recovered.interruptedConsensusTaskId, null)
    assert.equal(recovered.metadataSnapshot.status, 'idle')
    assert.deepEqual(recovered.initialMessages.slice(0, -1), [
      ...baseMessages,
      message('user', consensusRequest),
    ])
    assert.equal(isTurnAbortedMessage(recovered.initialMessages.at(-1)!), true)
    assert.equal(recovered.messagesBeforeTurn('m1'), null)
  })

  it('共识任务终点原子提交稳定状态', async () => {
    const store = await createStore()
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    await journal.recordConsensusTaskStart('task-1', consensusState(1), '提交共识任务')
    const committed = consensusState(1, '最终方案')
    await journal.recordConsensusTaskEnd('task-1', 'completed', committed)

    const reopened = await store.open(journal.sessionId)
    assert.equal(reopened.interruptedConsensusTaskId, null)
    assert.equal(reopened.metadataSnapshot.status, 'idle')
    assert.deepEqual(reopened.initialConsensusState, committed)
  })

  it('达到工具循环上限时保留执行进度供用户继续', async () => {
    const store = await createStore()
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    await journal.recordConsensusTaskStart('task-1', consensusState(1), '继续长任务')
    const user = message('user', '继续长任务')
    const assistant = message('assistant', '已完成部分工作')
    await journal.recordTurnStart('execution', [user])
    await journal.recordStep('execution', [assistant])
    await journal.recordTurnEnd('execution', 'max-turns')
    const committed = consensusState(1, '部分进度')
    await journal.recordConsensusTaskEnd('task-1', 'max-turns', committed)

    const reopened = await store.open(journal.sessionId)
    assert.deepEqual(reopened.initialMessages, [user, assistant])
    assert.deepEqual(reopened.initialConsensusState, committed)
    assert.equal(reopened.metadataSnapshot.status, 'max-turns')
  })

  it('任务计划随稳定 step 持久化，并记录每个 turn 的计划起点', async () => {
    const store = await createStore()
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    const plan = taskPlan(1)
    const currentState = state(plan)
    await journal.recordTurnStart('turn-1', [message('user', '开始长任务')])
    await journal.recordStep('turn-1', [message('assistant', '已建立计划')], currentState)
    await journal.recordTurnEnd('turn-1', 'paused')
    await journal.recordTurnStart('turn-2', [message('user', '继续')])
    await journal.recordTurnEnd('turn-2', 'completed')

    const reopened = await store.open(journal.sessionId)
    assert.deepEqual(reopened.initialTaskState, currentState)
    assert.deepEqual(reopened.taskStateBeforeTurn('turn-1'), state(null))
    assert.deepEqual(reopened.taskStateBeforeTurn('turn-2'), currentState)
    assert.equal(reopened.metadataSnapshot.status, 'idle')
  })

  it('重启时用权威 TaskPlanState 修复计划卡的窄崩溃窗口', async () => {
    const store = await createStore()
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    const plan = taskPlan(1)
    const activeState = state(plan)
    await journal.recordTurnStart('create-plan', [message('user', '建立计划')])
    await journal.recordStep('create-plan', [message('assistant', '计划已建立')], activeState)
    await journal.recordTurnEnd('create-plan', 'paused')

    const recoveredCreate = await store.open(journal.sessionId)
    const restoredActive = recoveredCreate.initialViewEvents.findLast((entry) =>
      entry.type === 'core-event' && entry.event.type === 'task-plan-restored')
    assert.equal(
      restoredActive?.type === 'core-event'
      && restoredActive.event.type === 'task-plan-restored'
      && restoredActive.event.plan?.id,
      plan.id,
    )

    await recoveredCreate.recordViewEvents([{ type: 'core-event', event: {
      type: 'task-plan-updated',
      plan,
    } }])
    await recoveredCreate.recordTurnStart('close-plan', [message('user', '放弃计划')])
    await recoveredCreate.recordStep(
      'close-plan',
      [message('assistant', '计划已放弃')],
      state(null, 2, {
        historicalPlans: [{
          id: plan.id,
          goal: plan.goal,
          status: 'abandoned',
          summary: '用户明确放弃',
          completedItems: 0,
          totalItems: plan.items.length,
          revision: 2,
        }],
      }),
    )
    await recoveredCreate.recordTurnEnd('close-plan', 'completed')

    const recoveredClose = await store.open(journal.sessionId)
    const restoredNull = recoveredClose.initialViewEvents.findLast((entry) =>
      entry.type === 'core-event' && entry.event.type === 'task-plan-restored')
    assert.equal(
      restoredNull?.type === 'core-event'
      && restoredNull.event.type === 'task-plan-restored'
      && restoredNull.event.plan,
      null,
    )
  })

  it('重启后恢复替换后的活动计划，并保留被替代计划的完整历史事件', async () => {
    const store = await createStore()
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    const previous = taskPlan(1)
    const previousState = state(previous)
    await journal.recordTurnStart('old-task', [message('user', '开发蔚蓝')])
    await journal.recordStep('old-task', [message('assistant', '建立旧计划')], previousState)
    await journal.recordTurnEnd('old-task', 'paused')

    const next = activeTaskPlanSchema.parse({
      ...taskPlan(1),
      id: '22222222-2222-4222-8222-222222222222',
      goal: '开发 CSGO',
    })
    const nextState = state(next, 2, {
      historicalPlans: [{
        id: previous.id,
        goal: previous.goal,
        status: 'superseded',
        summary: '用户明确切换游戏',
        completedItems: 0,
        totalItems: previous.items.length,
        revision: previous.revision + 1,
      }],
    })
    await journal.recordTurnStart('replacement', [message('user', '改做 CSGO')])
    await journal.recordViewEvents([{ type: 'core-event', event: {
      type: 'task-plan-replaced',
      previous: {
        ...previous,
        status: 'superseded',
        summary: '用户明确切换游戏',
        replacedByPlanId: next.id,
      },
      plan: next,
    } }])
    await journal.recordStep('replacement', [message('assistant', '已替换计划')], nextState)
    await journal.recordTurnEnd('replacement', 'paused')

    const reopened = await store.open(journal.sessionId)
    assert.deepEqual(reopened.initialTaskState, nextState)
    const replacement = reopened.initialViewEvents.find((entry) =>
      entry.type === 'core-event' && entry.event.type === 'task-plan-replaced')
    assert.equal(
      replacement?.type === 'core-event'
      && replacement.event.type === 'task-plan-replaced'
      && replacement.event.previous.goal,
      '完成长任务',
    )
  })

  it('压缩和对话回滚跨重启保留完整任务状态', async () => {
    const store = await createStore()
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    const plan = taskPlan(1)
    const savedState = state(plan, 7, {
      historicalPlans: [{
        id: '33333333-3333-4333-8333-333333333333',
        goal: '已完成的历史任务',
        status: 'completed',
        summary: '历史任务已验证交付',
        completedItems: 2,
        totalItems: 2,
        revision: 3,
      }],
      resumeRequired: true,
      interruptionReason: 'user-cancel',
    })
    await journal.recordTurnStart('turn-1', [message('user', '开始')])
    await journal.recordStep('turn-1', [message('assistant', '计划中')], savedState)
    await journal.recordTurnEnd('turn-1', 'paused')
    await journal.recordSnapshot('compact', [message('user', '摘要')])

    let reopened = await store.open(journal.sessionId)
    assert.deepEqual(reopened.initialTaskState, savedState)

    await reopened.recordTurnStart('turn-2', [message('user', '新一轮')])
    const changedState = state(taskPlan(2), 8, {
      historicalPlans: savedState.historicalPlans,
    })
    await reopened.recordStep('turn-2', [message('assistant', '推进')], changedState)
    await reopened.recordTurnEnd('turn-2', 'completed')
    const beforeTurn = reopened.taskStateBeforeTurn('turn-2')
    assert.deepEqual(beforeTurn, savedState)
    await reopened.recordSnapshot('rollback', [message('user', '摘要')], undefined, beforeTurn)

    reopened = await store.open(journal.sessionId)
    assert.deepEqual(reopened.initialTaskState, savedState)
  })

  it('半截共识恢复和取消都会回到任务起点的计划状态', async () => {
    const store = await createStore()
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    const base = taskPlan(1)
    const baseState = state(base)
    await journal.recordTurnStart('base', [message('user', '已有任务')])
    await journal.recordStep('base', [message('assistant', '已有计划')], baseState)
    await journal.recordTurnEnd('base', 'paused')
    await journal.recordUserInput('执行新方案', true)
    await journal.recordConsensusTaskStart('task-1', consensusState(1), '执行新方案')
    await journal.recordTurnStart('execution', [message('user', '执行新方案')])
    await journal.recordStep('execution', [message('assistant', '推进中')], state(taskPlan(2)))

    const interrupted = await store.open(journal.sessionId)
    assert.deepEqual(interrupted.initialTaskState, baseState)

    await journal.recordTurnEnd('execution', 'aborted')
    await journal.recordConsensusTaskEnd('task-1', 'aborted', consensusState(1))
    const cancelled = await store.open(journal.sessionId)
    assert.deepEqual(cancelled.initialTaskState, baseState)
  })

  it('快照保留活动共识边界和最后稳定状态', async () => {
    const store = await createStore()
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    const state = consensusState(1)
    await journal.recordUserInput('压缩中的共识请求', true)
    await journal.recordConsensusTaskStart('task-1', state, '压缩中的共识请求')
    await journal.recordSnapshot('compact', [message('user', '压缩摘要')])

    const reopened = await store.open(journal.sessionId)
    assert.equal(reopened.interruptedConsensusTaskId, 'task-1')
    assert.equal(reopened.undeliveredUserInputIds.length, 0)
    assert.deepEqual(reopened.initialConsensusState, state)
    assert.deepEqual(reopened.initialMessages, [message('user', '压缩中的共识请求')])
  })

  it('活动共识快照后的未交付根输入在取消恢复时只出现一次，且重放不修改记录', async () => {
    const store = await createStore()
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    const state = consensusState(1)
    await journal.recordUserInput('原始共识请求', true)
    await journal.recordConsensusTaskStart('task-snapshot-root', state, '原始共识请求')
    await journal.recordSnapshot('compact', [message('user', '压缩摘要')])
    await journal.recordUserInput('快照后的未交付消息', true)
    await journal.recordConsensusTaskEnd('task-snapshot-root', 'aborted', state)

    const transcript = join(
      storeRoots.get(store)!,
      journal.sessionId,
      'transcript.jsonl',
    )
    const entries = parseTranscript(await readFile(transcript, 'utf8'))
    const originalEntries = structuredClone(entries)
    const first = buildLoadedSession(entries)
    const second = buildLoadedSession(entries)

    assert.deepEqual(entries, originalEntries)
    assert.deepEqual(first.messages.slice(0, -1), [
      message('user', '原始共识请求'),
      message('user', '快照后的未交付消息'),
    ])
    assert.equal(first.messages.filter((entry) =>
      JSON.stringify(entry).includes('快照后的未交付消息')).length, 1)
    assert.equal(isTurnAbortedMessage(first.messages.at(-1)!), true)
    assert.deepEqual(second.messages, first.messages)
  })

  it('共识取消时回滚任务内模型消息', async () => {
    const store = await createStore()
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    const baseMessages = [message('user', '稳定上下文'), message('assistant', '稳定回答')]
    await journal.recordTurnStart('base', [baseMessages[0]!])
    await journal.recordStep('base', [baseMessages[1]!])
    await journal.recordTurnEnd('base', 'completed')
    const state = consensusState(1)
    await journal.recordConsensusTaskStart('task-1', state, '分析新请求')
    await journal.recordTurnStart('m1', [message('user', '内部协议提示')])
    await journal.recordStep('m1', [message('assistant', '半截候选')])
    await journal.recordTurnEnd('m1', 'completed')
    await journal.recordConsensusTaskEnd('task-1', 'aborted', state)

    assert.deepEqual(journal.messagesBeforeTurn('base'), [])
    assert.equal(journal.messagesBeforeTurn('m1'), null)
    assert.equal(journal.taskStateBeforeTurn('m1'), undefined)

    const reopened = await store.open(journal.sessionId)
    assert.equal(reopened.metadataSnapshot.status, 'idle')
    assert.deepEqual(reopened.initialMessages.slice(0, -1), [
      ...baseMessages,
      message('user', '分析新请求'),
    ])
    assert.equal(isTurnAbortedMessage(reopened.initialMessages.at(-1)!), true)
    assert.equal(reopened.messagesBeforeTurn('m1'), null)
    assert.equal(reopened.taskStateBeforeTurn('m1'), undefined)
  })

  it('metadata 损坏时从 transcript 重建会话列表', async () => {
    const { store, journal, metadata } = await completedSession()
    await journal.updateModelSelection('test:other-model', 'default')
    await writeFile(metadata, '{broken', 'utf8')

    const sessions = await store.list()
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0]!.sessionId, journal.sessionId)
    assert.equal(sessions[0]!.resumable, true)
    assert.equal(sessions[0]!.title, 'hello')
    assert.equal(sessions[0]!.modelId, 'test:other-model')
  })

  it('多个活动 Journal 同时以实时 metadata 进入列表，不从写入中的 transcript 重开', async () => {
    const store = await createStore()
    const first = await store.create({
      workspace: localWorkspace('C:\\work\\first-live'),
      modelId: 'test:first',
    })
    const second = await store.create({
      workspace: localWorkspace('C:\\work\\second-live'),
      modelId: 'test:second',
    })
    const root = storeRoots.get(store)!
    await writeFile(join(root, first.sessionId, 'transcript.jsonl'), '{active write')
    await writeFile(join(root, second.sessionId, 'transcript.jsonl'), '{active write')

    const summaries = await store.list(undefined, [
      first.metadataSnapshot,
      second.metadataSnapshot,
    ])

    assert.deepEqual(
      new Set(summaries.map((summary) => summary.sessionId)),
      new Set([first.sessionId, second.sessionId]),
    )
    assert.equal(summaries.every((summary) => summary.resumable), true)
  })

  it('旧 schema 会话仍在列表中可见但不可恢复', async () => {
    const store = await createStore()
    const root = storeRoots.get(store)!
    const sessionId = randomUUID()
    const sessionDir = join(root, sessionId)
    const timestamp = '2026-07-10T01:02:03.000Z'
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, 'transcript.jsonl'), `${JSON.stringify({
      schemaVersion: 2,
      type: 'session-start',
      sessionId,
      uuid: randomUUID(),
      parentUuid: null,
      timestamp,
      projectDir: 'C:\\work\\legacy',
      modelId: 'test:legacy',
    })}\n`, 'utf8')
    await writeFile(join(sessionDir, 'metadata.json'), JSON.stringify({
      schemaVersion: 2,
      sessionId,
      projectDir: 'C:\\work\\legacy',
      modelId: 'test:legacy',
      title: '旧版会话',
      lastUserText: '继续旧任务',
      createdAt: timestamp,
      updatedAt: timestamp,
      status: 'idle',
    }), 'utf8')

    const [summary] = await store.list()
    assert.equal(summary?.sessionId, sessionId)
    assert.equal(summary?.title, '旧版会话')
    assert.equal(summary?.workspace, undefined)
    assert.equal(summary?.modelId, 'test:legacy')
    assert.equal(summary?.status, 'unavailable')
    assert.equal(summary?.resumable, false)
    assert.match(summary?.unavailableReason ?? '', /无法恢复/)
    assert.equal((await store.list('C:\\work\\legacy')).length, 0)
  })

  it('损坏的 UUID 会话目录返回最小摘要，非 UUID 目录仍忽略', async () => {
    const store = await createStore()
    const root = storeRoots.get(store)!
    const sessionId = randomUUID()
    await mkdir(join(root, sessionId), { recursive: true })
    await writeFile(join(root, sessionId, 'transcript.jsonl'), '{broken', 'utf8')
    await writeFile(join(root, sessionId, 'metadata.json'), JSON.stringify({
      sessionId: randomUUID(),
      projectDir: null,
      title: '其它会话的标题',
      updatedAt: '2026-07-10T01:02:03.000Z',
    }), 'utf8')
    await mkdir(join(root, 'not-a-session'), { recursive: true })
    await writeFile(join(root, 'not-a-session', 'transcript.jsonl'), '{broken', 'utf8')

    const sessions = await store.list()
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0]!.sessionId, sessionId)
    assert.equal(sessions[0]!.title, '无法恢复的会话')
    assert.equal(sessions[0]!.workspace, undefined)
    assert.equal(sessions[0]!.resumable, false)
    assert.equal(sessions[0]!.status, 'unavailable')
    assert.doesNotThrow(() => new Date(sessions[0]!.updatedAt).toISOString())
    assert.equal((await store.list(null)).length, 0)
  })

  it('持久删除标记优先于 live metadata，且只允许重试删除', async () => {
    const store = await createStore()
    const journal = await store.create({ workspace: localWorkspace('C:\\work\\delete'), modelId: 'test:model' })
    await journal.recordUserInput('待删除会话', true)

    assert.equal(await store.markDeleting(journal.sessionId), true)
    assert.equal(await store.markDeleting(journal.sessionId), true)

    const [summary] = await store.list(undefined, [journal.metadataSnapshot])
    assert.equal(summary?.sessionId, journal.sessionId)
    assert.equal(summary?.resumable, false)
    assert.equal(summary?.status, 'unavailable')
    assert.match(summary?.unavailableReason ?? '', /删除未完成.*重试删除/)
    await assert.rejects(store.open(journal.sessionId), /删除未完成.*重试删除/)

    assert.equal(await store.delete(journal.sessionId), true)
    assert.equal((await store.list()).length, 0)
  })

  it('会话目录已消失时，外置删除标记仍保留重试入口', async () => {
    const store = await createStore()
    const root = storeRoots.get(store)!
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    const paths = getSessionPaths(root, journal.sessionId)
    assert.equal(await store.markDeleting(journal.sessionId), true)

    // 模拟递归删除完成后、清除 tombstone 前进程退出。
    await rm(paths.sessionDir, { recursive: true, force: true })
    await access(paths.deletionMarker)
    const [summary] = await store.list(undefined, [journal.metadataSnapshot])
    assert.equal(summary?.sessionId, journal.sessionId)
    assert.equal(summary?.resumable, false)
    assert.match(summary?.unavailableReason ?? '', /重试删除/)

    assert.equal(await store.delete(journal.sessionId), true)
    await assert.rejects(access(paths.deletionMarker))
    assert.equal((await store.list()).length, 0)
  })

  it('不存在的会话不能建立持久删除标记', async () => {
    const store = await createStore()
    assert.equal(await store.markDeleting(randomUUID()), false)
  })

  it('按项目过滤并安全删除会话', async () => {
    const store = await createStore()
    const first = await store.create({ workspace: localWorkspace('C:\\work\\one'), modelId: 'test:model' })
    await store.create({ workspace: localWorkspace('C:\\work\\two'), modelId: 'test:model' })
    const firstDir = join(storeRoots.get(store)!, first.sessionId)
    await mkdir(join(firstDir, 'checkpoints', 'manifests'), { recursive: true })
    await writeFile(join(firstDir, 'metadata.json.leftover.tmp'), 'temporary', 'utf8')
    await writeFile(join(firstDir, 'checkpoints', 'manifests', 'checkpoint.json'), '{}', 'utf8')

    assert.equal((await store.list('C:\\work\\one')).length, 1)
    assert.equal(await store.delete(first.sessionId), true)
    assert.equal(await store.delete(first.sessionId), false)
    await assert.rejects(access(firstDir))
    assert.equal((await store.list()).length, 1)
    await assert.rejects(store.open('../escape'), /无效会话 ID/)
  })
})

async function createStore(): Promise<SessionStore> {
  const root = await mkdtemp(join(tmpdir(), 'whycode-session-'))
  tempRoots.push(root)
  const store = new SessionStore(root)
  storeRoots.set(store, root)
  return store
}

async function completedSession() {
  const store = await createStore()
  const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
  await journal.recordUserInput('hello', true)
  await journal.recordTurnStart('turn-1', [message('user', 'hello')])
  await journal.recordStep('turn-1', [message('assistant', 'world')])
  await journal.recordTurnEnd('turn-1', 'completed')
  const dir = join(storeRoots.get(store)!, journal.sessionId)
  return {
    store,
    journal,
    transcript: join(dir, 'transcript.jsonl'),
    metadata: join(dir, 'metadata.json'),
  }
}

async function waitingQuestionSession() {
  const store = await createStore()
  const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
  const question = {
    id: 'question-crash-window',
    questions: [{
      header: '运行系统',
      question: '你使用哪个系统？',
      options: [
        { label: 'Windows', description: '按 Windows 环境处理' },
        { label: 'macOS', description: '按 macOS 环境处理' },
      ],
    }],
  }
  const questionEvent = {
    type: 'core-event' as const,
    event: { type: 'user-question' as const, question },
  }
  const answer = '回答「你使用哪个系统？」：Windows'
  await journal.recordTurnStart('question-turn', [message('user', '继续任务')])
  await journal.recordStep('question-turn', [createUserQuestionMarker(question, true)])
  await journal.recordViewEvents([questionEvent])
  await journal.recordTurnEnd('question-turn', 'waiting-user')
  return { store, journal, questionEvent, answer }
}

function message(role: 'user' | 'assistant', content: string): ModelMessage {
  return { role, content }
}

function modelText(value: ModelMessage): string {
  if (typeof value.content === 'string') return value.content
  return value.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('')
}

function countMessage(messages: readonly ModelMessage[], expected: ModelMessage): number {
  const serialized = JSON.stringify(expected)
  return messages.filter((entry) => JSON.stringify(entry) === serialized).length
}

function consensusState(taskCounter: number, summary?: string): ConsensusPersistedState {
  return {
    taskCounter,
    sessionScore: { Main: summary ? 1 : 0, B: 0, C: 0 },
    memories: { B: [], C: [] },
    taskLog: summary ? [{ taskId: `task-${taskCounter}`, userText: '请求', m1Summary: summary }] : [],
  }
}

function activatedSkillFixture(): ActivatedSkill {
  const content = '---\nname: verify-build\ndescription: 执行构建并核对字面结果\n---\nVERIFY_BODY'
  const path = 'C:\\work\\skill-project\\.agents\\skills\\verify-build\\SKILL.md'
  return {
    id: skillId(path),
    path,
    rootPath: 'C:\\work\\skill-project\\.agents\\skills\\verify-build',
    name: 'verify-build',
    description: '执行构建并核对字面结果',
    scope: 'project',
    digest: skillContentDigest(content),
    content,
  }
}

function taskPlan(revision: number): ActiveTaskPlan {
  return activeTaskPlanSchema.parse({
    id: '11111111-1111-4111-8111-111111111111',
    goal: '完成长任务',
    status: 'active',
    revision,
    items: [
      {
        id: 'T1',
        kind: 'work',
        title: '实现',
        acceptance: '实现完成',
        status: revision > 1 ? 'completed' : 'in_progress',
        evidence: revision > 1 ? ['代码完成'] : [],
      },
      {
        id: 'T2',
        kind: 'verification',
        title: '验证',
        acceptance: '测试通过',
        status: revision > 1 ? 'in_progress' : 'pending',
        evidence: [],
      },
    ],
  })
}

function state(
  activePlan: ActiveTaskPlan | null,
  version = activePlan?.revision ?? 0,
  overrides: Partial<Pick<
    TaskPlanState,
    'historicalPlans' | 'resumeRequired' | 'interruptionReason'
  >> = {},
): TaskPlanState {
  return {
    version,
    activePlan,
    historicalPlans: [],
    resumeRequired: false,
    interruptionReason: null,
    ...overrides,
  }
}
