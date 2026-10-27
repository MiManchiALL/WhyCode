import assert from 'node:assert/strict'
import { mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { it } from 'node:test'
import {
  AgentSession, SkillCatalogService, SubagentDefinitionCatalogService, type WorkspaceIO,
} from '@whycode/core'
import { sshFixture } from './ssh-test-fixture.ts'
import { languageModel, modelEntry, finalStream } from '../subagent-test-fixture.ts'

it('SSH 连续对话按当前文件生成请求，正文读取失败释放句柄，后续轮次可恢复', async t => {
  const env = await sshFixture(t)
  await env.store.trust(env.id, env.fingerprint)
  await writeFile(join(env.root, 'project/.git'), 'fixture')
  const skillRoot = join(env.root, '.whycode/skills/.system')
  for (let index = 0; index < 10; index++) {
    const name = `skill-${index}`
    await mkdir(join(skillRoot, name, 'scripts/resources'), { recursive: true })
    await writeFile(join(skillRoot, name, 'SKILL.md'), document(name, 'First instruction'))
  }
  const firstFile = join(skillRoot, 'skill-0/SKILL.md')
  const firstStat = await stat(firstFile)

  await env.connections.withFiles(env.id, async fs => {
    let openFiles = 0
    let peakOpenFiles = 0
    let failRead = false
    const io: WorkspaceIO = {
      identity: 'fixture-ssh', path: posix, platform: 'linux',
      fs: {
        ...fs,
        open: async (path, flags) => {
          const file = await fs.open(path, flags)
          peakOpenFiles = Math.max(peakOpenFiles, ++openFiles)
          return {
            stat: () => file.stat(),
            read: (...args) => {
              if (failRead && path.endsWith('/skill-2/SKILL.md')) return Promise.reject(new Error('fixture read failed'))
              return file.read(...args)
            },
            close: async () => { await file.close(); openFiles-- },
          }
        },
      },
    }
    const requests: string[] = []
    const errors: string[] = []
    const catalog = new SkillCatalogService({ homeDir: env.remoteRoot, workspaceIO: io })
    const definitions = new SubagentDefinitionCatalogService()
    const session = new AgentSession({
      model: modelEntry(languageModel(async request => {
        assert.equal(openFiles, 0, '请求模型前所有预读句柄已关闭')
        const catalogText = request.prompt.flatMap(message => typeof message.content === 'string'
          ? [] : message.content.flatMap(part => part.type === 'text' ? [part.text] : []))
          .find(text => text.includes('<whycode-skill-catalog '))
        assert.ok(catalogText)
        requests.push(catalogText)
        return finalStream('你好')
      })),
      providerConfig: { apiKey: 'fixture' }, workspaceIO: io,
      promptContext: { projectDir: env.project, homeDir: env.remoteRoot, osPlatform: 'linux' },
      skillCatalog: catalog, loadSubagentCatalog: () => definitions.snapshot(env.project, io),
      emit: event => { if (event.type === 'error') errors.push(event.message) },
      requestApproval: async () => ({ approved: false }),
    })
    try {
      await session.initializeContextUsage()
      assert.equal(await session.handleUserMessage('你好'), 'completed')
      assert.match(requests[0]!, /First instruction/)
      assert.match(requests[0]!, /- skill-1 \|/)

      // SFTP v3 只能看到秒级时间；等长且时间不变也不能沿用旧内容。
      await writeFile(firstFile, document('skill-0', 'Other instruction'))
      await utimes(firstFile, firstStat.atime, firstStat.mtime)
      await rm(join(skillRoot, 'skill-1'), { recursive: true })
      await mkdir(join(skillRoot, 'added'))
      await writeFile(join(skillRoot, 'added/SKILL.md'), document('added', 'New instruction'))
      failRead = true
      assert.equal(await session.handleUserMessage('再问一次'), 'completed')
      assert.match(requests[1]!, /Other instruction/)
      assert.match(requests[1]!, /- added \|/)
      assert.doesNotMatch(requests[1]!, /- skill-[12] \|/)
      assert.equal(openFiles, 0)

      failRead = false
      assert.equal(await session.handleUserMessage('继续'), 'completed')
      assert.match(requests[2]!, /- skill-2 \|/)
      assert.deepEqual(errors, [])
      assert.ok(peakOpenFiles > 1 && peakOpenFiles <= 8)
    } finally {
      await session.dispose()
      assert.equal(openFiles, 0)
    }
  })
})

function document(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\nInstructions.`
}
