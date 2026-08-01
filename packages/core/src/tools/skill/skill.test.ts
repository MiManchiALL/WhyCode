import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import type { SkillTurnSnapshot } from '../../skills/types.ts'
import { createSkillTool } from './index.ts'

describe('Skill 工具资源边界', () => {
  it('SKILL.md 使用 turn 冻结快照，引用文件限制在包根目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-skill-tool-'))
    try {
      const packageRoot = join(root, 'demo')
      const skillPath = join(packageRoot, 'SKILL.md')
      await mkdir(join(packageRoot, 'references'), { recursive: true })
      await writeFile(skillPath, '磁盘新版本', 'utf8')
      await writeFile(join(packageRoot, 'references', 'guide.md'), '参考资料', 'utf8')
      const tool = createSkillTool(snapshot(skillPath, packageRoot, '冻结版本'))
      const context = {
        projectDir: root,
        additionalDirs: [],
        abortSignal: new AbortController().signal,
      }

      const body = await tool.execute({ skillId: ID }, context)
      assert.equal(body.isError, false)
      assert.match(body.data, /冻结版本/)
      assert.doesNotMatch(body.data, /磁盘新版本/)

      const reference = await tool.execute({
        skillId: ID,
        resourcePath: 'references/guide.md',
      }, context)
      assert.equal(reference.isError, false)
      assert.match(reference.data, /参考资料/)

      const traversal = await tool.execute({ skillId: ID, resourcePath: '../outside.md' }, context)
      assert.equal(traversal.isError, true)
      const nestedTraversal = await tool.execute({
        skillId: ID,
        resourcePath: 'references/../SKILL.md',
      }, context)
      assert.equal(nestedTraversal.isError, true)
      const ambiguousSkillPath = await tool.execute({
        skillId: ID,
        resourcePath: './SKILL.md',
      }, context)
      assert.equal(ambiguousSkillPath.isError, true)
      const driveRelative = await tool.execute({
        skillId: ID,
        resourcePath: 'C:secret.txt',
      }, context)
      assert.equal(driveRelative.isError, true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('拒绝解析到包外的文件软链', async (context) => {
    if (process.platform === 'win32') {
      context.skip('Windows 普通测试账户通常没有创建文件软链权限')
      return
    }
    const root = await mkdtemp(join(tmpdir(), 'whycode-skill-link-'))
    try {
      const packageRoot = join(root, 'demo')
      const skillPath = join(packageRoot, 'SKILL.md')
      const outside = join(root, 'secret.txt')
      await mkdir(dirname(skillPath), { recursive: true })
      await writeFile(skillPath, 'body', 'utf8')
      await writeFile(outside, 'secret', 'utf8')
      await symlink(outside, join(packageRoot, 'linked.txt'), 'file')
      const tool = createSkillTool(snapshot(skillPath, packageRoot, 'body'))
      const result = await tool.execute(
        { skillId: ID, resourcePath: 'linked.txt' },
        { projectDir: root, additionalDirs: [], abortSignal: new AbortController().signal },
      )
      assert.equal(result.isError, true)
      assert.doesNotMatch(result.data, /secret$/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

const ID = `skill:${'a'.repeat(64)}`

function snapshot(path: string, rootPath: string, content: string): SkillTurnSnapshot {
  const entry = {
    id: ID,
    path,
    rootPath,
    name: 'demo',
    description: 'demo skill',
    scope: 'project' as const,
    digest: `sha256:${'b'.repeat(64)}`,
    content,
  }
  return {
    revision: `sha256:${'c'.repeat(64)}`,
    entries: [entry],
    skills: [{
      id: entry.id,
      path: entry.path,
      rootPath: entry.rootPath,
      name: entry.name,
      description: entry.description,
      scope: entry.scope,
    }],
    diagnostics: [],
    modelContext: 'catalog',
    omittedCount: 0,
  }
}
