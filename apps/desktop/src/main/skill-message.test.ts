import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ActivatedSkill, PendingUserInput, SkillLocator } from '@whycode/core'
import { prepareMessageSkills } from './skill-message.ts'

describe('Desktop Skill 消息准备', () => {
  it('恢复草稿复用 JSONL 完整快照，不受当前磁盘内容变化影响', async () => {
    const frozen = skill('a', 'C:/project/.agents/skills/review/SKILL.md', 'OLD_BODY')
    const current = { ...frozen, digest: digest('d'), content: 'NEW_BODY' }
    const activator = fakeActivator([current])
    const result = await prepareMessageSkills({
      catalog: activator,
      locators: [locator(frozen)],
      projectDir: 'C:/project',
      restoredInputIds: ['input-1'],
      pendingInputs: [pending('input-1', frozen)],
    })

    assert.deepEqual(result, [frozen])
    assert.deepEqual(activator.calls, [])
  })

  it('按选择顺序混合恢复快照和本次新选 Skill', async () => {
    const frozen = skill('a', 'C:/project/.agents/skills/review/SKILL.md', 'OLD_BODY')
    const added = skill('b', 'C:/project/.agents/skills/build/SKILL.md', 'BUILD_BODY')
    const activator = fakeActivator([added])
    const result = await prepareMessageSkills({
      catalog: activator,
      locators: [locator(added), locator(frozen)],
      projectDir: 'C:/project',
      restoredInputIds: ['input-1'],
      pendingInputs: [pending('input-1', frozen)],
    })

    assert.deepEqual(result, [added, frozen])
    assert.deepEqual(activator.calls, [[locator(added)]])
  })

  it('拒绝重复选择和相互冲突的恢复快照', async () => {
    const first = skill('a', 'C:/project/.agents/skills/review/SKILL.md', 'FIRST')
    const conflicting = { ...first, digest: digest('e'), content: 'SECOND' }
    const activator = fakeActivator([])

    await assert.rejects(
      prepareMessageSkills({
        catalog: activator,
        locators: [locator(first), locator(first)],
        projectDir: 'C:/project',
      }),
      /重复选择/,
    )
    await assert.rejects(
      prepareMessageSkills({
        catalog: activator,
        locators: [locator(first)],
        projectDir: 'C:/project',
        restoredInputIds: ['input-1', 'input-2'],
        pendingInputs: [pending('input-1', first), pending('input-2', conflicting)],
      }),
      /相互冲突/,
    )
  })
})

function fakeActivator(results: ActivatedSkill[]) {
  const calls: SkillLocator[][] = []
  return {
    calls,
    async activateMany(locators: readonly SkillLocator[]) {
      calls.push(structuredClone([...locators]))
      return structuredClone(results)
    },
  }
}

function pending(id: string, selected: ActivatedSkill): PendingUserInput {
  return { id, text: '恢复消息', skills: [selected], state: 'restored' }
}

function locator(value: ActivatedSkill): SkillLocator {
  return { id: value.id, path: value.path }
}

function skill(seed: string, path: string, content: string): ActivatedSkill {
  return {
    id: `skill:${seed.repeat(64)}`,
    path,
    rootPath: path.replace(/\/SKILL\.md$/, ''),
    name: path.includes('build') ? 'build' : 'review',
    description: '测试 Skill',
    scope: 'project',
    digest: digest(seed),
    content,
  }
}

function digest(seed: string): string {
  return `sha256:${seed.repeat(64)}`
}
