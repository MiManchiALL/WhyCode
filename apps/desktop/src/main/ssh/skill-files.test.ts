import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, access, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { localWorkspaceIO, type WorkspaceIO } from '@whycode/core'
import { readSkillTree, SKILL_SYNC_BYTES, SKILL_SYNC_MARKER } from './skill-files.ts'
import { cleanManagedSkills, managedSkills, ModifiedSshSkillsError, publishSkill } from './skill-remote.ts'
import { sshSkillIdSchema } from '../../shared/ssh-skills.ts'

async function fixture(t: TestContext) {
  const temporary = await realpath(tmpdir())
  const root = await mkdtemp(join(temporary, 'whycode-skills-'))
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(temporary, 'whycode-skills-'))); await rm(root, { recursive: true, force: true }) })
  const source = join(root, 'source')
  const home = join(root, 'remote')
  await mkdir(source); await mkdir(home)
  await writeFile(join(source, 'SKILL.md'), '第一版')
  const metadata = { name: 'alpha', description: 'test' }
  return { root, source, home, metadata, destination: join(home, '.whycode/skills/alpha') }
}

test('更新发布失败恢复原副本，上传失败不留下半成品或私有元数据', async t => {
  const env = await fixture(t)
  const first = await readSkillTree(localWorkspaceIO, env.source)
  await publishSkill(localWorkspaceIO, env.home, 'alpha', first, env.metadata)
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(env.destination, SKILL_SYNC_MARKER), 'utf8'))).sort(), ['description', 'digest', 'name', 'owner'])
  await writeFile(join(env.source, 'SKILL.md'), '第二版')
  const second = await readSkillTree(localWorkspaceIO, env.source)
  let failed = false
  const io: WorkspaceIO = { ...localWorkspaceIO, fs: { ...localWorkspaceIO.fs, rename: async (from, to) => {
    if (!failed && to === env.destination && from.includes('.whycode-sync-')) { failed = true; throw new Error('模拟发布失败') }
    await localWorkspaceIO.fs.rename(from, to)
  } } }
  await assert.rejects(publishSkill(io, env.home, 'alpha', second, env.metadata, first.digest), /模拟发布失败/)
  assert.equal(await readFile(join(env.destination, 'SKILL.md'), 'utf8'), '第一版')
  assert.equal((await managedSkills(localWorkspaceIO, env.home)).length, 1)
  const broken: WorkspaceIO = { ...localWorkspaceIO, fs: { ...localWorkspaceIO.fs, writeFile: async (file, data, options) => {
    if (file.endsWith('SKILL.md')) throw new Error('模拟上传失败')
    await localWorkspaceIO.fs.writeFile(file, data, options)
  } } }
  await assert.rejects(publishSkill(broken, env.home, 'beta', second, { ...env.metadata, name: 'beta' }), /模拟上传失败/)
  await assert.rejects(access(join(env.home, '.whycode/skills/beta')), { code: 'ENOENT' })
  assert.equal((await managedSkills(localWorkspaceIO, env.home)).length, 1)
})

test('清理未完成同步目录及空父目录，拒绝路径穿越和目录链接', async t => {
  const env = await fixture(t)
  const tree = await readSkillTree(localWorkspaceIO, env.source)
  const temporaryId = '.whycode-sync-12345678-1234-1234-1234-123456789abc'
  await publishSkill(localWorkspaceIO, env.home, temporaryId, tree, env.metadata)
  assert.equal((await managedSkills(localWorkspaceIO, env.home))[0]!.id, temporaryId)
  await cleanManagedSkills(localWorkspaceIO, env.home, {})
  await assert.rejects(access(join(env.home, '.whycode')), { code: 'ENOENT' })
  for (const value of ['../escape', '/escape', 'a/../b', 'C:/escape', 'a\\b', 'a//b']) assert.equal(sshSkillIdSchema.safeParse(value).success, false)
  const outside = join(env.root, 'outside')
  await mkdir(outside); await writeFile(join(outside, 'keep.txt'), 'keep')
  await symlink(outside, join(env.home, '.whycode'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(publishSkill(localWorkspaceIO, env.home, 'alpha', tree, env.metadata), /普通目录/)
  await assert.rejects(cleanManagedSkills(localWorkspaceIO, env.home, {}), /普通目录/)
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep')
})

test('完整文件树读取有体积上限，资源链接不能跨出 Skill', async t => {
  const env = await fixture(t)
  await writeFile(join(env.source, 'large'), Buffer.alloc(SKILL_SYNC_BYTES + 1))
  await assert.rejects(readSkillTree(localWorkspaceIO, env.source), /20 MiB/)
  await rm(join(env.source, 'large'))
  await symlink(env.home, join(env.source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(readSkillTree(localWorkspaceIO, env.source), /符号链接/)
})

test('清理中断且归属文件已删除后，残留仍可确认清空', async t => {
  const env = await fixture(t)
  const tree = await readSkillTree(localWorkspaceIO, env.source)
  await publishSkill(localWorkspaceIO, env.home, 'group/alpha', tree, env.metadata)
  const interrupted: WorkspaceIO = { ...localWorkspaceIO, fs: { ...localWorkspaceIO.fs, rm: async (directory, options) => {
    if (directory.includes('.whycode-sync-')) {
      await rm(join(directory, SKILL_SYNC_MARKER))
      throw new Error('模拟删除中途断线')
    }
    await localWorkspaceIO.fs.rm(directory, options)
  } } }
  const results = await cleanManagedSkills(interrupted, env.home, {})
  assert.equal(results[0]!.ok, false)
  const [residue] = await managedSkills(localWorkspaceIO, env.home)
  assert.match(residue!.id, /^\.whycode-sync-/)
  assert.equal(residue!.marker, null)
  await assert.rejects(cleanManagedSkills(localWorkspaceIO, env.home, {}), ModifiedSshSkillsError)
  assert.equal(await readFile(join(env.home, '.whycode/skills', residue!.id, 'SKILL.md'), 'utf8'), '第一版')
  await cleanManagedSkills(localWorkspaceIO, env.home, { allowModified: [residue!.id] })
  await assert.rejects(access(join(env.home, '.whycode')), { code: 'ENOENT' })
})
