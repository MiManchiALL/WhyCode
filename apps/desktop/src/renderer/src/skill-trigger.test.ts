import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SkillSummary } from '@whycode/core/skills'
import { filterSkills, findSkillTrigger, removeSkillTrigger } from './skill-trigger.ts'

describe('Skill 输入触发器', () => {
  it('只识别输入边界处、光标前的 $ 查询', () => {
    assert.deepEqual(findSkillTrigger('$review', 7), {
      start: 0,
      end: 7,
      query: 'review',
    })
    assert.deepEqual(findSkillTrigger('请用 $rev', 7), {
      start: 3,
      end: 7,
      query: 'rev',
    })
    assert.equal(findSkillTrigger('价格$20', 5), null)
    assert.equal(findSkillTrigger('$review 后续', 10), null)
  })

  it('选择后只移除当前触发片段并返回稳定光标', () => {
    assert.deepEqual(removeSkillTrigger('请用 $review 处理', {
      start: 3,
      end: 10,
      query: 'review',
    }), {
      text: '请用 处理',
      cursor: 3,
    })
  })

  it('名称前缀、名称包含、描述包含依次排序，同名条目不去重', () => {
    const skills = [
      skill('skill:a', 'code-review', '检查代码', 'project'),
      skill('skill:b', 'docs', 'review documentation', 'user'),
      skill('skill:c', 'review', '另一份', 'user'),
      skill('skill:d', 'code-review', '全局版本', 'user'),
    ]
    assert.deepEqual(
      filterSkills(skills, 'review').map((item) => item.id),
      ['skill:c', 'skill:a', 'skill:d', 'skill:b'],
    )
  })
})

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
