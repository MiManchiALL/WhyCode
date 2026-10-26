import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import {
  createWebFetchTool, preparePdfAttachmentImport, readStoredImage,
  type ApprovalRequest, type PdfAttachment,
} from '@whycode/core'
import { documentProcessors, SMALL_JPEG } from './subagent-document-fixture.ts'
import { SubagentService } from './subagent-service.ts'
import { SubagentStorage } from './subagent-storage.ts'
import { createFixture, finalStream, toolStream, waitFor } from './subagent-test-fixture.ts'

type Fixture = Awaited<ReturnType<typeof createFixture>>

describe('子代理文档与视觉工具', () => {
  for (const role of ['explore', 'general']) {
    it(`${role} 的 Skill 声明遵循子代理自身命令权限`, async () => {
      let skillId = ''
      const fixture = await createFixture([], async index => index === 0
        ? toolStream('Skill', { skillId }, 'office-skill') : finalStream('已读取流程'), undefined, {
        prepareSkillRuntime: async (_skill, context) => context.canExecute ? 'OFFICE_READY' : 'OFFICE_DISABLED',
      })
      const skillPath = join(dirname(fixture.sessionsRoot), '.whycode/skills/.system/documents/SKILL.md')
      await mkdir(dirname(skillPath), { recursive: true })
      await writeFile(skillPath, '---\nname: documents\ndescription: Office\n---\nCreate documents.')
      skillId = (await fixture.serviceOptions.skills.list(fixture.projectDir)).skills[0]!.id
      await launch(fixture, role)
      const prompt = JSON.stringify(fixture.modelCalls[1]?.prompt)
      assert.match(prompt, role === 'explore' ? /OFFICE_DISABLED/ : /OFFICE_READY/)
      assert.doesNotMatch(prompt, role === 'explore' ? /OFFICE_READY/ : /OFFICE_DISABLED/)
      await fixture.service.close()
    })
  }

  for (const role of ['explore', 'reviewer', 'general']) {
    for (const visual of [false, true]) {
      it(`${role} 按自己的${visual ? '视觉' : '文字'}模型装配工具，保留角色边界`, async () => {
        const fixture = await createFixture(['完成'], undefined, undefined, {
          supportsImageInput: visual, parentSupportsImageInput: !visual,
        })
        await launch(fixture, role)
        const names = fixture.modelCalls[0]!.tools!.map((tool) => tool.name)
        assert.ok(names.includes('ReadFile'))
        for (const name of ['CaptureScreenshot']) {
          assert.equal(names.includes(name), visual, name)
        }
        assert.equal(names.includes('AnalyzeImage'), false)
        assert.equal(names.includes('RunCommand'), role !== 'explore')
        assert.equal(names.includes('WriteFile'), role === 'general')
        for (const name of ['Subagent', 'AskUserQuestion']) {
          assert.equal(names.includes(name), false, name)
        }
        assert.ok(names.includes('CreateTaskPlan'))
        const definition = fixture.toolContext('turn', 'call').subagentDefinitions.find(item => item.name === role)!
        const allowed = new Set([
          ...definition.toolNames, 'CreateTaskPlan', 'ResumeTaskPlan', 'UpdateTaskItem', 'CloseTaskPlan',
        ])
        assert.ok(names.every(name => allowed.has(name)), '实际工具只能收窄目录声明的范围')
        const system = JSON.stringify(fixture.modelCalls[0]!.prompt[0])
        assert.doesNotMatch(system, /通用型桌面 AI Agent|首次调用前必须|移动或重命名文件使用/)
        if (role === 'explore') {
          assert.match(system, /从宽到窄搜索/)
          assert.doesNotMatch(system, /RunCommand|不要用命令|命令绕过/)
        } else if (role === 'reviewer') {
          assert.match(system, /独立审查和验证/)
          assert.match(system, /不得修改、删除或移动被审查的项目内容/)
          assert.doesNotMatch(system, /修改已有文本用 EditFile/)
        } else {
          assert.match(system, /独立完成边界明确的委派/)
          assert.match(system, /修改已有文本用 EditFile/)
        }
        await fixture.service.close()
      })
    }
  }

  it('文字子代理实际读取 PDF 文字，不生成图片或改写源文件', async () => {
    const documents = documentProcessors()
    const fixture = await createFixture([], async (index, call) => {
      if (index === 0) return toolStream('ReadFile', {
        path: 'paper.pdf', pages: '1',
      }, 'pdf')
      assert.match(JSON.stringify(call.prompt), /第一页正文/)
      return finalStream('已核验文字和结构。')
    }, undefined, { ...documents, parentSupportsImageInput: true })
    await writeSources(fixture)
    const id = await launch(fixture)
    assert.deepEqual(documents.operations, ['pdf:text'])
    const stored = await new SubagentStorage(fixture.sessionsRoot, documents.pdfProcessor)
      .open(fixture.parentJournal.sessionId, id)
    assert.equal(stored.initialImageAttachments.length, 0)
    assert.equal(await readFile(join(fixture.projectDir, 'paper.pdf'), 'utf8'), '%PDF-1.4\npaper')
    await fixture.service.close()
  })

  it('视觉子代理的渲染、PDF 页图及截图归属自身，冷恢复仍能读取并展示', async () => {
    const documents = documentProcessors()
    const fixture = await createFixture([], async (index, call) => {
      if (index === 0) return toolStream('ReadFile', {
        path: 'paper.pdf', pages: '1',
      }, 'pdf')
      if (index === 1) return toolStream('CaptureScreenshot', { target: 'window', window_title: '测试' }, 'capture')
      assert.ok(JSON.stringify(call.prompt).includes(SMALL_JPEG.toString('base64')))
      return finalStream('已核验页面图。')
    }, undefined, { ...documents, supportsImageInput: true, parentSupportsImageInput: false })
    const approvals: ApprovalRequest[] = []
    fixture.runtime.requestApproval = async (request) => {
      approvals.push(request)
      return { approved: true }
    }
    await writeSources(fixture)
    const id = await launch(fixture, 'reviewer')
    assert.deepEqual(documents.operations, ['pdf:visual', 'screenshot'])
    assert.equal(approvals.length, 1)
    assert.match(JSON.stringify(approvals[0]), /截图会读取/)
    assert.equal(fixture.parentJournal.initialImageAttachments.length, 0)
    await fixture.service.close()

    const coldService = new SubagentService(fixture.serviceOptions)
    const stored = await new SubagentStorage(fixture.sessionsRoot, documents.pdfProcessor)
      .open(fixture.parentJournal.sessionId, id)
    assert.equal(stored.initialImageAttachments.length, 2)
    const directory = await coldService.attachmentDirectory(fixture.parentJournal.sessionId, id)
    for (const attachment of stored.initialImageAttachments) {
      assert.equal(attachment.sessionId, id)
      assert.ok((await readStoredImage(directory, attachment.storageName)).bytes.length > 0)
    }
    await assert.rejects(coldService.attachmentDirectory(randomUUID(), id))
    const tools = coldService.createTools(fixture.runtime, fixture.parentJournal, fixture.projectDir)
    const result = await tools[1]!.execute({ subagent_id: id, prompt: '继续核验' }, fixture.toolContext('next', 'next'))
    assert.equal(result.isError, false)
    await waitFor(() => fixture.settlements.length === 2)
    assert.equal(fixture.settlements[1]?.outcome, 'completed')
    await coldService.close()
  })

  it('网页导入的子代理 PDF 附件可在重建服务后继续读取', async () => {
    const documents = documentProcessors()
    let attachment: PdfAttachment | undefined
    const fixture = await createFixture([], async (index) => {
      if (index === 0) return toolStream('WebFetch', { url: 'https://example.test/paper.pdf' }, 'fetch')
      if (index === 2) return toolStream('ReadFile', {
        path: `attachment://${attachment!.id}`, pages: '1',
      }, 'read-imported')
      return finalStream('完成。')
    }, undefined, {
      ...documents,
      createWebPageTools: (journal) => [createWebFetchTool({
        fetchPage: async (request, signal) => {
          const transaction = await preparePdfAttachmentImport(
            [{ kind: 'bytes', name: 'paper.pdf', bytes: Buffer.from('%PDF-1.4\npaper') }],
            journal.attachmentDirectory, journal.sessionId, documents.pdfProcessor, signal,
          )
          await transaction.commit()
          attachment = { ...transaction.attachments[0]!, origin: 'web' }
          return { kind: 'pdf', requestedUrl: request.url, finalUrl: request.url, contentType: 'application/pdf', attachment }
        },
      })],
    })
    fixture.runtime.requestApproval = async () => ({ approved: true })
    const id = await launch(fixture)
    await fixture.service.close()
    const coldService = new SubagentService(fixture.serviceOptions)
    const tools = coldService.createTools(fixture.runtime, fixture.parentJournal, fixture.projectDir)
    const continued = await tools[1]!.execute({ subagent_id: id, prompt: '读取已保存的 PDF' }, fixture.toolContext('next', 'next'))
    assert.equal(continued.isError, false, continued.data)
    await waitFor(() => fixture.settlements.length === 2)
    assert.equal(fixture.settlements[1]?.outcome, 'completed')
    assert.match(JSON.stringify(fixture.modelCalls.at(-1)?.prompt), /第一页正文/)
    assert.deepEqual(documents.operations, ['pdf:text'])
    assert.equal(fixture.parentJournal.initialPdfAttachments.length, 0)
    await coldService.close()
  })

  it('模型强行调用被能力过滤的工具也无法执行', async () => {
    const documents = documentProcessors()
    const fixture = await createFixture([], async (index) => index === 0
      ? toolStream('CaptureScreenshot', { target: 'screen' }) : finalStream('仅核验文字。'),
    undefined, documents)
    await launch(fixture)
    assert.deepEqual(documents.operations, [])
    assert.match(JSON.stringify(fixture.modelCalls.at(-1)?.prompt), /unavailable tool 'CaptureScreenshot'/)
    await fixture.service.close()
  })

  it('冻结定义收窄后，动态视觉工具和宿主工具一起移除，仍保留独立计划', async () => {
    const fixture = await createFixture(['完成', '继续完成'], undefined, undefined, { supportsImageInput: true })
    const id = await launch(fixture)
    const storage = new SubagentStorage(fixture.sessionsRoot)
    const manifest = await storage.readManifest(fixture.parentJournal.sessionId, id)
    manifest.definition.toolNames = ['ReadFile']
    await storage.writeManifest(manifest)
    const tools = fixture.service.createTools(fixture.runtime, fixture.parentJournal, fixture.projectDir)
    await tools[1]!.execute({ subagent_id: id, prompt: '继续' }, fixture.toolContext('next', 'next'))
    await waitFor(() => fixture.settlements.length === 2)
    const names = fixture.modelCalls.at(-1)!.tools!.map((tool) => tool.name)
    assert.ok(names.includes('ReadFile'))
    assert.ok(names.includes('CreateTaskPlan'))
    for (const name of ['CaptureScreenshot', 'WebSearch']) {
      assert.equal(names.includes(name), false, name)
    }
    await fixture.service.close()
  })

  it('越界文件和截图沿用父会话审批，拒绝后不执行处理器', async () => {
    const documents = documentProcessors()
    const fixture = await createFixture([], async (index) => {
      if (index === 0) return toolStream('ReadFile', { path: '../outside.pdf' }, 'pdf')
      if (index === 1) return toolStream('CaptureScreenshot', { target: 'screen' }, 'capture')
      return finalStream('权限不足。')
    }, undefined, { ...documents, supportsImageInput: true })
    const approvals: ApprovalRequest[] = []
    fixture.runtime.requestApproval = async (request) => {
      approvals.push(request)
      return { approved: false }
    }
    await launch(fixture)
    assert.deepEqual(approvals.map((request) => request.toolName), ['ReadFile', 'CaptureScreenshot'])
    assert.deepEqual(documents.operations, [])
    await fixture.service.close()
  })
})

async function launch(fixture: Fixture, role = 'explore'): Promise<string> {
  const tools = fixture.service.createTools(fixture.runtime, fixture.parentJournal, fixture.projectDir)
  const result = await tools[0]!.execute({
    name: role, description: '核验文档', prompt: '检查文档内容与版式',
  }, fixture.toolContext('turn-doc', 'start-doc'))
  assert.equal(result.isError, false, result.data)
  const id = result.data.match(/[0-9a-f-]{36}/u)?.[0]
  assert.ok(id)
  await waitFor(() => fixture.settlements.length === 1)
  assert.equal(fixture.settlements[0]?.outcome, 'completed', fixture.settlements[0]?.resultText)
  return id
}

async function writeSources(fixture: Fixture): Promise<void> {
  await writeFile(join(fixture.projectDir, 'paper.pdf'), '%PDF-1.4\npaper')
}
