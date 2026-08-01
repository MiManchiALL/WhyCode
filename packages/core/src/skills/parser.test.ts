import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { join } from 'node:path'
import { parseSkillDocument } from './parser.ts'
import {
  activatedSkillSchema,
  SKILL_MAX_DOCUMENT_BYTES,
} from './types.ts'

describe('Agent Skills 标准解析', () => {
  it('解析必填 frontmatter 并保留完整 SKILL.md 快照', () => {
    const content = [
      '---',
      'name: release-notes',
      'description: 生成可靠的发布说明',
      'metadata:',
      '  owner: team',
      '---',
      '# 工作流',
      '先核对提交。',
    ].join('\n')
    const skill = parseSkillDocument({
      path: join('repo', '.agents', 'skills', 'release-notes', 'SKILL.md'),
      scope: 'project',
      content,
    })

    assert.equal(skill.name, 'release-notes')
    assert.equal(skill.description, '生成可靠的发布说明')
    assert.equal(skill.content, content)
    assert.match(skill.id, /^skill:[a-f0-9]{64}$/)
    assert.match(skill.digest, /^sha256:[a-f0-9]{64}$/)
  })

  it('严格拒绝目录名不一致、非法名称和重复 YAML key', () => {
    assert.throws(() => parse('wrong-dir', 'name: right-name\ndescription: test'), /目录名一致/)
    assert.throws(() => parse('Bad_Name', 'name: Bad_Name\ndescription: test'), /name 必须/)
    assert.throws(
      () => parse('same', 'name: same\nname: same\ndescription: test'),
      /YAML 无效/,
    )
  })

  it('JSONL/IPC 快照按 UTF-8 字节而不是字符数执行文档上限', () => {
    const oversized = '界'.repeat(Math.floor(SKILL_MAX_DOCUMENT_BYTES / 3) + 1)
    const result = activatedSkillSchema.safeParse({
      id: `skill:${'a'.repeat(64)}`,
      path: 'C:/project/.agents/skills/verify/SKILL.md',
      rootPath: 'C:/project/.agents/skills/verify',
      name: 'verify',
      description: '验证',
      scope: 'project',
      digest: `sha256:${'b'.repeat(64)}`,
      content: oversized,
    })

    assert.equal(result.success, false)
    if (!result.success) assert.match(result.error.message, /字节上限/)

    const isolated = activatedSkillSchema.safeParse({
      id: `skill:${'a'.repeat(64)}`,
      path: 'C:/project/.agents/skills/verify/SKILL.md',
      rootPath: 'C:/project/.agents/skills/verify',
      name: 'verify',
      description: '验证',
      scope: 'project',
      digest: `sha256:${'b'.repeat(64)}`,
      content: 'broken\uD83C',
    })
    assert.equal(isolated.success, false)
    if (!isolated.success) assert.match(isolated.error.message, /孤立 Unicode 代理项/)
  })
})

function parse(directory: string, yaml: string) {
  return parseSkillDocument({
    path: join('repo', '.agents', 'skills', directory, 'SKILL.md'),
    scope: 'project',
    content: `---\n${yaml}\n---\nbody`,
  })
}
