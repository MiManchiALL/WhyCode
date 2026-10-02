import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { createSkillTool } from '../tools/skill/index.ts'
import { SkillCatalogService } from './catalog.ts'
import {
  installSystemSkills,
  systemSkillsRoot,
  SYSTEM_SKILLS_MARKER_FILE,
  userSkillsRoot,
} from './system.ts'

const EXPECTED_SYSTEM_SKILLS = [
  'code-review',
  'documents',
  'find-simplifications',
  'presentations',
  'simplify',
  'skill-creator',
  'spreadsheets',
]

const GENERAL_SKILL_CONTRACTS = new Map<string, readonly RegExp[]>([
  ['code-review', [/实际 base 和 head/, /不是充分证据/, /作者得知后大概率会修复/]],
  ['find-simplifications', [/只有请求明确指向整个项目/, /仅有测试与文档引用/, /只在多个机制表达同一事实时建议合并/]],
  ['simplify', [/已选定的简化候选/, /记录修改过程或已经失效的注释/, /只合并表达同一事实的机制/, /不为单次使用新增抽象/]],
  ['skill-creator', [/只询问会阻断设计/, /\.whycode\/skills\/<name>/, /默认只写指令/]],
])

describe('内置 Skill 安装与发现', () => {
  it('物化固定内置集合，并以 system 作用域进入统一目录快照', async () => {
    const home = await mkdtemp(join(tmpdir(), 'whycode-system-skills-'))
    try {
      const installed = await installSystemSkills(home)
      assert.equal(installed.changed, true)
      assert.equal(installed.rootPath, systemSkillsRoot(home))
      assert.equal(dirname(installed.rootPath), userSkillsRoot(home))

      const snapshot = await new SkillCatalogService({ homeDir: home }).snapshot(null)
      assert.deepEqual(snapshot.skills.map((skill) => skill.name), EXPECTED_SYSTEM_SKILLS)
      assert.ok(snapshot.skills.every((skill) => skill.scope === 'system'))

      for (const [skillName, expectations] of GENERAL_SKILL_CONTRACTS) {
        const skill = snapshot.entries.find((entry) => entry.name === skillName)!
        const frontmatter = /^---\n([\s\S]*?)\n---/.exec(skill.content)
        assert.ok(frontmatter)
        assert.deepEqual(
          frontmatter[1]!.split('\n').map((line) => line.slice(0, line.indexOf(':'))),
          ['name', 'description'],
        )
        for (const expectation of expectations) assert.match(skill.content, expectation)
      }

      const creator = snapshot.entries.find((skill) => skill.name === 'skill-creator')!
      const reference = await createSkillTool(snapshot).execute({
        skillId: creator.id,
        resourcePath: 'references/checklist.md',
      }, {
        projectDir: home,
        additionalDirs: [],
        abortSignal: new AbortController().signal,
      })
      assert.equal(reference.isError, false)
      assert.match(reference.data, /WhyCode Skill 检查清单/)

      for (const skillName of ['documents', 'presentations', 'spreadsheets']) {
        const skill = snapshot.entries.find((entry) => entry.name === skillName)!
        assert.match(skill.description, /读取/)
        const main = await readFile(join(installed.rootPath, skillName, 'SKILL.md'), 'utf8')
        assert.match(main, /LoadWorkspaceDependencies/)
        assert.match(main, /RunCommand/)
        assert.match(main, /ViewImage/)
        const reference = await createSkillTool(snapshot).execute({
          skillId: skill.id, resourcePath: 'references/commands.md',
        }, { projectDir: home, additionalDirs: [], abortSignal: new AbortController().signal })
        assert.equal(reference.isError, false)
        assert.match(reference.data, /import /)
      }

      const repeated = await installSystemSkills(home)
      assert.equal(repeated.changed, false)
      assert.equal(repeated.fingerprint, installed.fingerprint)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('指纹变化时整目录替换，清除不属于当前发布集合的托管文件', async () => {
    const home = await mkdtemp(join(tmpdir(), 'whycode-system-skills-'))
    try {
      const root = (await installSystemSkills(home)).rootPath
      const stale = join(root, 'obsolete', 'SKILL.md')
      await mkdir(dirname(stale), { recursive: true })
      await writeFile(stale, 'stale', 'utf8')
      await writeFile(join(root, SYSTEM_SKILLS_MARKER_FILE), 'stale-fingerprint\n', 'utf8')

      assert.equal((await installSystemSkills(home)).changed, true)
      await assert.rejects(access(stale))
      assert.match(await readFile(join(root, 'simplify', 'SKILL.md'), 'utf8'), /name: simplify/)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('拒绝把非目录对象当成托管系统目录，不删除路径上的现有对象', async () => {
    const home = await mkdtemp(join(tmpdir(), 'whycode-system-skills-'))
    try {
      const root = systemSkillsRoot(home)
      await mkdir(dirname(root), { recursive: true })
      await writeFile(root, 'keep', 'utf8')

      await assert.rejects(installSystemSkills(home), /普通目录/)
      assert.equal(await readFile(root, 'utf8'), 'keep')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('同名用户 Skill 与内置 Skill 都保留，用户目录按既有优先级排在前面', async () => {
    const home = await mkdtemp(join(tmpdir(), 'whycode-system-skills-'))
    try {
      await installSystemSkills(home)
      const userSkill = join(userSkillsRoot(home), 'simplify', 'SKILL.md')
      await mkdir(dirname(userSkill), { recursive: true })
      await writeFile(
        userSkill,
        '---\nname: simplify\ndescription: 我的简化流程\n---\n# Simplify\n',
        'utf8',
      )

      const snapshot = await new SkillCatalogService({ homeDir: home }).snapshot(null)
      const simplifySkills = snapshot.skills.filter((skill) => skill.name === 'simplify')
      assert.deepEqual(simplifySkills.map((skill) => skill.scope), ['user', 'system'])
      assert.equal(new Set(simplifySkills.map((skill) => skill.id)).size, 2)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
