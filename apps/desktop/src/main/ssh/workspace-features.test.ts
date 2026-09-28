import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { it, type TestContext } from 'node:test'
import { AgentSession, CheckpointManager, SessionStore, SkillCatalogService, createReadPdfTool, createSkillTool, inspectLatestTurnEdit,
  type PdfProcessor, type ToolContext, type WorkspaceIO } from '@whycode/core'
import { createViewImageTool } from '../../../../../packages/core/src/tools/view-image/index.ts'
import { readBoundedWorkspaceFile } from '../../../../../packages/core/src/workspace/read.ts'
import { sshFixture } from './ssh-test-fixture.ts'
import { copyDirectorySnapshot } from '../directory-snapshot.ts'
import { WorkspaceFiles } from '../workspace-files.ts'
import { languageModel, modelEntry, finalStream } from '../subagent-test-fixture.ts'

async function withWorkspace(t: TestContext, run: (env: Awaited<ReturnType<typeof sshFixture>>, io: WorkspaceIO, ctx: ToolContext) => Promise<void>) {
  const env = await sshFixture(t)
  await env.store.trust(env.id, env.fingerprint)
  await writeFile(join(env.root, 'project/.git'), 'fixture')
  await env.connections.withFiles(env.id, async fs => {
    const io: WorkspaceIO = { identity: 'fixture-ssh', path: posix, platform: 'linux', fs }
    await run(env, io, { workspaceIO: io, projectDir: env.project, additionalDirs: [], abortSignal: new AbortController().signal })
  })
}

it('SSH Skill 从远端发现、选择和读取资源，等长修改立即更新且不混入本机路径', async t => {
  await withWorkspace(t, async (env, io, ctx) => {
    const root = join(env.root, 'project/.agents/skills/review')
    await mkdir(root, { recursive: true })
    const content = '---\nname: review\ndescription: Review remote code\n---\nFirst instruction.'
    await writeFile(join(root, 'SKILL.md'), content)
    await writeFile(join(root, 'notes.md'), 'Remote reference')
    const catalog = new SkillCatalogService({ homeDir: env.remoteRoot, workspaceIO: io })
    const snapshot = await catalog.snapshot(env.project)
    assert.equal(snapshot.entries.length, 1)
    const skill = snapshot.entries[0]!
    assert.equal(skill.path, `${env.project}/.agents/skills/review/SKILL.md`)
    assert.equal((await catalog.activate({ id: skill.id, path: skill.path }, env.project)).content, content)
    const otherHost = new SkillCatalogService({ homeDir: env.remoteRoot, workspaceIO: { ...io, identity: 'another-server' } })
    assert.notEqual((await otherHost.list(env.project)).skills[0]!.id, skill.id)
    await assert.rejects(otherHost.activate({ id: skill.id, path: skill.path }, env.project), /不属于当前工作区/)
    const tool = createSkillTool(snapshot)
    assert.match((await tool.execute({ skillId: skill.id, resourcePath: 'notes.md' }, ctx)).data, /Remote reference/)
    assert.equal((await tool.execute({ skillId: skill.id, resourcePath: '../notes.md' }, ctx)).isError, true)
    await symlink(join(env.root, 'project'), join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal((await tool.execute({ skillId: skill.id, resourcePath: 'escape/.git' }, ctx)).isError, true)
    await writeFile(join(root, 'SKILL.md'), content.replace('First', 'Other'))
    assert.match((await catalog.snapshot(env.project)).entries[0]!.content, /Other instruction/)
    assert.match(snapshot.entries[0]!.content, /First instruction/)
  })
})

it('SSH 图片和 PDF 通过 SFTP 读取、由本机处理；读取失败和取消释放临时文件', async t => {
  await withWorkspace(t, async (env, io, ctx) => {
    const sessionId = randomUUID()
    const attachmentDirectory = join(env.root, 'attachments')
    const jpeg = Buffer.from('/9j/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAEAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AD//Z', 'base64')
    await writeFile(join(env.root, 'project/photo.jpg'), jpeg)
    const image = createViewImageTool({ attachmentDirectory, sessionId })
    const result = await image.execute(image.inputSchema.parse({ path: 'photo.jpg' }), ctx)
    assert.equal(result.isError, false)
    assert.equal(result.attachments?.[0]?.name, 'photo.jpg')
    assert.deepEqual(await readFile(join(attachmentDirectory, result.attachments![0]!.storageName)), jpeg)
    await assert.rejects(image.execute(image.inputSchema.parse({ path: '../identity' }), ctx), /超出允许范围/)
    await assert.rejects(readBoundedWorkspaceFile(`${env.project}/photo.jpg`, 1, io), /超过/)
    const abort = new AbortController(); abort.abort()
    await assert.rejects(readBoundedWorkspaceFile(`${env.project}/photo.jpg`, jpeg.length, io, abort.signal), /abort/i)

    await writeFile(join(env.root, 'project/report.pdf'), '%PDF fixture')
    let staged = ''
    let fail = false
    const processor: PdfProcessor = {
      inspect: async () => ({ pageCount: 1, byteLength: 12 }),
      readPages: async path => {
        staged = path
        assert.notEqual(path, `${env.project}/report.pdf`)
        assert.equal(await readFile(path, 'utf8'), '%PDF fixture')
        if (fail) throw new Error('invalid PDF')
        return { mode: 'text', pageCount: 1, pages: [{ pageNumber: 1, text: 'Remote PDF content' }] }
      },
    }
    const pdf = createReadPdfTool({ attachmentDirectory, sessionId, processor, supportsVisual: false, resolveAttachment: () => null })
    const input = pdf.inputSchema.parse({ sourceType: 'path', sourceValue: 'report.pdf' })
    assert.match((await pdf.execute(input, ctx)).data, /Remote PDF content/)
    await assert.rejects(access(staged), { code: 'ENOENT' })
    fail = true
    await assert.rejects(pdf.execute(input, ctx), /invalid PDF/)
    await assert.rejects(access(staged), { code: 'ENOENT' })
  })
})

it('SSH 历史支持编辑和冲突保护，Fork 重定位 POSIX 临时文件与检查点，保存到本机不改变服务器文件', async t => {
  await withWorkspace(t, async (env, io) => {
    const store = new SessionStore(join(env.root, 'sessions'))
    const workspace = { mode: 'ssh' as const, target: io.identity, label: 'fixture', workingDirectory: env.project }
    const journal = await store.create({ workspace, modelId: 'test:subagent' })
    const scratchParent = `${env.remoteRoot}/scratch`
    const scratch = `${scratchParent}/${journal.sessionId}`
    await io.fs.mkdir(`${scratch}/Main`, { recursive: true })
    const file = `${scratch}/Main/report.txt`
    await io.fs.writeFile(file, 'before')
    const id = randomUUID()
    await journal.recordUserInputWithId(id, 'original question', true)
    await journal.recordTurnStart('turn', [{ role: 'user', content: 'original question' }], undefined, [], undefined, id)
    await journal.recordViewEvents([{ type: 'core-event', event: { type: 'turn-start', turnId: 'turn' } }])
    const checkpoints = new CheckpointManager({ sessionId: journal.sessionId, sessionDir: journal.checkpointDirectory, workspaceIO: io })
    const prepared = await checkpoints.prepare('write', 'turn', { kind: 'exact-files', paths: [file] })
    await io.fs.writeFile(file, 'after')
    await checkpoints.finalize(prepared!)
    await journal.recordStep('turn', [{ role: 'assistant', content: 'original answer' }])
    await journal.recordTurnEnd('turn', 'completed')
    await journal.recordViewEvents([{ type: 'core-event', event: { type: 'work-finished', durationMs: 1, outcome: 'completed', forkTurnId: 'turn' } }])

    const fork = await store.fork(journal, 'turn', scratchParent)
    const forkScratch = `${scratchParent}/${fork.sessionId}`
    await io.fs.mkdir(forkScratch)
    await copyDirectorySnapshot(scratch, forkScratch, io)
    const forkCheckpoints = new CheckpointManager({ sessionId: fork.sessionId, sessionDir: fork.checkpointDirectory, workspaceIO: io })
    assert.equal((await forkCheckpoints.restore('write', 'files')).ok, true)
    assert.equal(await io.fs.readFile(`${forkScratch}/Main/report.txt`, 'utf8'), 'before')
    assert.equal(await io.fs.readFile(file, 'utf8'), 'after')
    await assert.rejects(io.fs.mkdir(forkScratch))

    assert.deepEqual(await inspectLatestTurnEdit(await store.open(journal.sessionId), 'turn'), {
      hasFileChanges: true, hasUntrackedEffects: false,
    })

    const session = new AgentSession({ model: modelEntry(languageModel(async () => finalStream('edited answer'))), providerConfig: { apiKey: 'test' },
      workspaceIO: io, sessionRecorder: journal, promptContext: { projectDir: env.project, osPlatform: 'linux' },
      requestApproval: async () => ({ approved: true }), emit: () => {},
    })
    assert.deepEqual(await session.inspectLatestTurnEdit('turn'), { hasFileChanges: true, hasUntrackedEffects: false })
    await io.fs.writeFile(file, 'external change')
    await assert.rejects(session.prepareLatestTurnEdit('turn', 'edited question', true), /已拒绝覆盖/)
    assert.match(JSON.stringify(journal.initialMessages), /original answer/)
    await io.fs.writeFile(file, 'after')
    await session.prepareLatestTurnEdit('turn', 'edited question', true)
    assert.equal(await io.fs.readFile(file, 'utf8'), 'before')
    assert.doesNotMatch(JSON.stringify(journal.initialMessages), /original answer/)
    await session.dispose()

    const files = new WorkspaceFiles()
    const view = await files.open(1, { runtimeId: 'test', kind: 'file', path: file }, env.project, () => {}, io)
    const destination = join(env.root, 'download.txt')
    await writeFile(destination, 'old local content')
    await files.save(1, view.id, destination)
    assert.equal(await readFile(destination, 'utf8'), 'before')
    assert.equal(await io.fs.readFile(file, 'utf8'), 'before')
    await assert.rejects(files.save(2, view.id, destination), /已关闭/)
    files.close(1, view.id)
    await assert.rejects(files.save(1, view.id, destination), /已关闭/)
    assert.ok(!(await readdir(env.root)).some(name => name.endsWith('.download')))
  })
})
