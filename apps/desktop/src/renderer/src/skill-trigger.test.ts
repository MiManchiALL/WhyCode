import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SkillSummary } from '@whycode/core/skills'
import {
  filterComposerItems,
  findSlashTrigger,
  removeSlashTrigger,
  type ComposerCommand,
} from './skill-trigger.ts'

describe('Slash 功能触发器', () => {
  it('只识别当前行输入起点的 slash 查询', () => {
    assert.deepEqual(findSlashTrigger('/review', 7), {
      start: 0,
      end: 7,
      query: 'review',
    })
    assert.deepEqual(findSlashTrigger('上一行\n  /压缩', 9), {
      start: 6,
      end: 9,
      query: '压缩',
    })
    assert.equal(findSlashTrigger('请用 /review', 10), null)
    assert.equal(findSlashTrigger('C:/project', 10), null)
    assert.equal(findSlashTrigger('/review 后续', 10), null)
  })

  it('选择后只移除当前 slash 片段并返回稳定光标', () => {
    assert.deepEqual(removeSlashTrigger('说明\n  /review 后续', {
      start: 5,
      end: 12,
      query: 'review',
    }), {
      text: '说明\n  后续',
      cursor: 5,
    })
  })

  it('功能在前、Skill 在后，并按名称与描述匹配', () => {
    const skills = [
      skill('skill:a', 'code-review', '检查代码', 'project'),
      skill('skill:b', 'docs', 'review documentation', 'user'),
      skill('skill:c', 'review', '另一份', 'user'),
      skill('skill:d', 'code-review', '全局版本', 'user'),
    ]
    const commands: ComposerCommand[] = [{
      id: 'compact',
      name: '压缩',
      description: '压缩当前会话上下文',
      keywords: ['compact', 'context'],
      disabled: false,
    }]
    assert.deepEqual(
      filterComposerItems(commands, skills, new Set(), 'review').map(itemId),
      ['skill:c', 'skill:a', 'skill:d', 'skill:b'],
    )
    assert.deepEqual(
      filterComposerItems(commands, skills, new Set(['skill:c']), 'review').map(itemId),
      ['skill:a', 'skill:d', 'skill:b'],
    )
    assert.deepEqual(
      filterComposerItems(commands, skills, new Set(), 'compact').map(itemId),
      ['command:compact'],
    )
  })
})

function itemId(item: ReturnType<typeof filterComposerItems>[number]): string {
  return item.kind === 'command' ? `command:${item.command.id}` : item.skill.id
}

function skill(
  id: string,
  name: string,
  description: string,
  scope: 'project' | 'user',
): SkillSummary {
  return {
    id,
    path: `C:/skills/${id}/SKILL.md`,
    rootPath: `C:/skills/${id}`,
    name,
    description,
    scope,
  }
}
