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
} from './system.ts'

const EXPECTED_SYSTEM_SKILLS = [
  'code-review',
  'debug',
  'documents',
  'presentations',
  'simplify',
  'skill-creator',
  'spreadsheets',
  'verify',
]

describe('内置 Skill 安装与发现', () => {
  it('物化固定内置集合，并以 system 作用域进入统一目录快照', async () => {
    const home = await mkdtemp(join(tmpdir(), 'whycode-system-skills-'))
    try {
      const installed = await installSystemSkills(home)
      assert.equal(installed.changed, true)
      assert.equal(installed.rootPath, systemSkillsRoot(home))

      const snapshot = await new SkillCatalogService({ homeDir: home }).snapshot(null)
      assert.deepEqual(snapshot.skills.map((skill) => skill.name), EXPECTED_SYSTEM_SKILLS)
      assert.ok(snapshot.skills.every((skill) => skill.scope === 'system'))
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
        assert.match(skill.description, /读取、分析、创建、修改或验收/)
        const main = await readFile(join(installed.rootPath, skillName, 'SKILL.md'), 'utf8')
        assert.match(main, /只读问答/)
        assert.match(main, /quality-checklist\.md/)
        assert.match(main, /旧检查失效/)

        for (const [resourcePath, expected] of [
          ['references/builder-api.md', /构建接口/],
          ['references/quality-checklist.md', /交付质量清单/],
        ] as const) {
          const officeReference = await createSkillTool(snapshot).execute({
            skillId: skill.id,
            resourcePath,
          }, {
            projectDir: home,
            additionalDirs: [],
            abortSignal: new AbortController().signal,
          })
          assert.equal(officeReference.isError, false)
          assert.match(officeReference.data, expected)
          if (resourcePath === 'references/quality-checklist.md') {
            assert.match(
              officeReference.data,
              skillName === 'spreadsheets' ? /不能证明公式引擎已重算/ : /逐页检查/,
            )
          }
        }
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
      assert.match(await readFile(join(root, 'verify', 'SKILL.md'), 'utf8'), /name: verify/)
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
      const userSkill = join(home, '.agents', 'skills', 'verify', 'SKILL.md')
      await mkdir(dirname(userSkill), { recursive: true })
      await writeFile(
        userSkill,
        '---\nname: verify\ndescription: 我的验证流程\n---\n# Verify\n',
        'utf8',
      )

      const snapshot = await new SkillCatalogService({ homeDir: home }).snapshot(null)
      const verifySkills = snapshot.skills.filter((skill) => skill.name === 'verify')
      assert.deepEqual(verifySkills.map((skill) => skill.scope), ['user', 'system'])
      assert.equal(new Set(verifySkills.map((skill) => skill.id)).size, 2)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
