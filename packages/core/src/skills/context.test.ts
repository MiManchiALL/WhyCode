import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ModelMessage } from 'ai'
import { applySkillContext } from './context.ts'
import { skillSummary, type ActivatedSkill, type SkillTurnSnapshot } from './types.ts'

const BODY = 'CANONICAL_SKILL_BODY_f542'

describe('Skill 模型请求投影', () => {
  it('稳定目录占据缓存前缀，活动正文只追加到当前请求尾部', () => {
    const history: ModelMessage[] = [
      { role: 'user', content: '旧问题' },
      { role: 'assistant', content: '旧回答' },
      { role: 'user', content: '当前问题' },
    ]
    const projected = applySkillContext(history, catalog(), [skill()], new Set())

    assert.match(JSON.stringify(projected[0]), /available_skills/)
    assert.deepEqual(projected.slice(1, -1), history)
    assert.match(JSON.stringify(projected.at(-1)), /<whycode-active-skill id=/)
  })

  it('成功工具正文提升为当前根活动上下文，压缩输入和下一根任务都不保留原文', () => {
    const messages = [skillToolResult('skill-call', BODY)]
    const current = applySkillContext(messages, null, [skill()], new Set())
    const currentText = JSON.stringify(current)
    assert.equal(currentText.match(new RegExp(BODY, 'g'))?.length, 1)
    assert.match(currentText, /<whycode-active-skill id=/)
    assert.match(currentText, /Skill 工具正文不作为长期历史/)

    const compactionInput = applySkillContext(messages, null, [], new Set())
    assert.doesNotMatch(JSON.stringify(compactionInput), new RegExp(BODY))

    const nextRoot = applySkillContext(messages, null, [], new Set())
    assert.doesNotMatch(JSON.stringify(nextRoot), new RegExp(BODY))
  })

  it('当前根任务的失败结果保留给模型判断，下一根任务再冻结', () => {
    const messages = [skillToolResult('failed-skill', 'RESOURCE_NOT_FOUND')]
    const current = applySkillContext(messages, null, [], new Set(['failed-skill']))
    assert.match(JSON.stringify(current), /RESOURCE_NOT_FOUND/)

    const nextRoot = applySkillContext(messages, null, [], new Set())
    assert.doesNotMatch(JSON.stringify(nextRoot), /RESOURCE_NOT_FOUND/)
  })
})

function skill(): ActivatedSkill {
  return {
    id: `skill:${'a'.repeat(64)}`,
    path: 'C:/project/.agents/skills/verify/SKILL.md',
    rootPath: 'C:/project/.agents/skills/verify',
    name: 'verify',
    description: '验证结果',
    scope: 'project',
    digest: `sha256:${'b'.repeat(64)}`,
    content: BODY,
  }
}

function catalog(): SkillTurnSnapshot {
  const entry = skill()
  return {
    revision: `sha256:${'c'.repeat(64)}`,
    entries: [entry],
    skills: [skillSummary(entry)],
    diagnostics: [],
    modelContext: '<available_skills>verify</available_skills>',
    omittedCount: 0,
  }
}

function skillToolResult(toolCallId: string, value: string): ModelMessage {
  return {
    role: 'tool',
    content: [{
      type: 'tool-result',
      toolCallId,
      toolName: 'Skill',
      output: { type: 'text', value },
    }],
  }
}
