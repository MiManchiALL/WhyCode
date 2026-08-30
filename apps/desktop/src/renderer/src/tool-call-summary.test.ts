import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  summarizeToolCall,
  summarizeToolCallParts,
  toolCallDetails,
} from './tool-call-summary.ts'

describe('工具卡片关键参数摘要', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['ReadFile', { path: 'src/app.ts', offset: 11, limit: 20 }, 'src/app.ts · lines 11–30'],
    ['ListDir', { path: 'src' }, 'src'],
    ['Glob', { pattern: '**/*.tsx', path: 'apps' }, '“**/*.tsx” · apps'],
    ['Grep', { pattern: 'summarizeInput', path: 'apps', include: '*.tsx' }, '“summarizeInput” · apps · include *.tsx'],
    ['WriteFile', { path: 'src/new.ts', content: 'hidden' }, 'src/new.ts'],
    ['EditFile', { edits: [{ path: 'a.ts' }, { path: 'a.ts' }, { path: 'b.ts' }] }, '2 files'],
    ['DeleteFile', { paths: ['a.ts', 'b.ts'] }, '2 files'],
    ['MoveFile', { source: 'old.ts', destination: 'new.ts' }, 'old.ts → new.ts'],
    ['RunCommand', { command: 'pnpm test', cwd: 'E:\\Agent\\WhyCode', runInBackground: true, wakeOnCompletion: true }, 'pnpm test'],
    ['ListCommands', {}, ''],
    ['GetCommandOutput', { taskId: '12345678-1234-4234-8234-123456789abc', offset: 4096 }, 'task ID 12345678… · offset 4096'],
    ['WriteCommandInput', { taskId: '12345678-1234-4234-8234-123456789abc', input: 'yes', closeAfterWrite: true }, 'task ID 12345678… · 3 characters'],
    ['StopCommand', { taskId: '12345678-1234-4234-8234-123456789abc' }, 'task ID 12345678…'],
    ['WebSearch', { query: ['WhyCode', 'agent UI'], domains: ['github.com'], recency: 'week' }, 'WhyCode agent UI · past week'],
    ['WebFetch', { url: 'https://example.com/', offset: 101, limit: 100 }, 'https://example.com/ · lines 101–200'],
    ['WebFind', { url: 'https://example.com/', pattern: 'AgentSession' }, '“AgentSession” · https://example.com/'],
    ['ViewImage', { path: 'screen.png', detail: 'original' }, 'screen.png · original'],
    ['AnalyzeImage', { question: '按钮是否对齐？', attachmentIds: ['a', 'b'] }, '按钮是否对齐？ · 2 images'],
    ['CaptureScreenshot', { target: 'window', window_title: 'WhyCode' }, 'window · WhyCode'],
    ['CaptureScreenshot', { target: 'region', region: { x: 10, y: 20, width: 300, height: 200 } }, 'region · 300×200'],
    ['ReadPdf', { sourceType: 'path', sourceValue: 'guide.pdf', startPage: 3, pageCount: 4 }, 'guide.pdf · pages 3–6'],
    ['BuildOfficeArtifact', { outputPath: 'report.pptx', format: 'pptx', mode: 'template' }, 'report.pptx · PPTX · template'],
    ['InspectOffice', { path: 'report.xlsx', view: 'objects', sheetName: 'Summary', range: 'A1:F20', startUnit: 21, unitCount: 10 }, 'report.xlsx · objects · sheet Summary · A1:F20 · units 21–30'],
    ['RenderOffice', { path: 'report.pptx', view: 'overview', startPage: 1, pageCount: 12 }, 'report.pptx · overview · pages 1–12'],
    ['AskUserQuestion', { questions: [{ question: '保留还是替换？' }, { question: '是否推送？' }] }, '2 questions'],
    ['CreateTaskPlan', { goal: '完成工具摘要优化', items: [{}, {}, {}] }, '3 milestones'],
    ['ResumeTaskPlan', { plan_id: '12345678-1234-4234-8234-123456789abc' }, 'plan ID 12345678…'],
    ['UpdateTaskItem', { item_id: 'T2', status: 'completed', changes: [{ action: 'edit' }] }, 'T2 → complete · 1 plan change'],
    ['CloseTaskPlan', { plan_id: '12345678-1234-4234-8234-123456789abc' }, 'plan ID 12345678…'],
    ['Subagent', { agent_id: 'explore', description: '检查工具摘要', prompt: 'hidden' }, 'explore'],
    ['SendSubagentMessage', { subagent_id: '12345678-1234-4234-8234-123456789abc', prompt: '继续核对测试' }, '12345678…'],
    ['ListSubagents', {}, ''],
    ['ToolSearch', { query: 'GitHub file contents read', max_results: 5 }, '“GitHub file contents read” · max results 5'],
    ['SubmitProtocolOutput', { candidate: { summary: '采用统一摘要器' } }, '“采用统一摘要器”'],
  ]

  for (const [toolName, input, expected] of cases) {
    it(`${toolName} 展示动作所需的关键内容`, () => {
      assert.equal(summarizeToolCall(toolName, input), expected)
    })
  }

  it('Skill 展示目录中的稳定名称与 description', () => {
    const id = `skill:${'a'.repeat(64)}`
    assert.equal(summarizeToolCall('Skill', { skillId: id }, {
      skills: [{
        id,
        path: 'C:/skills/review/SKILL.md',
        rootPath: 'C:/skills/review',
        name: 'review',
        description: '审查当前改动并报告可行动问题',
        scope: 'user',
      }],
    }), 'review · 审查当前改动并报告可行动问题')
  })

  it('为搜索时间与图片数量提供不可截断的尾部摘要', () => {
    assert.deepEqual(summarizeToolCallParts('WebSearch', {
      query: ['今日头条', '热点新闻'],
      recency: 'day',
    }), { primary: '今日头条 热点新闻', trailing: 'past day' })
    assert.deepEqual(summarizeToolCallParts('AnalyzeImage', {
      question: '逐项检查界面中的对齐和留白是否一致',
      attachmentIds: ['a', 'b'],
    }), { primary: '逐项检查界面中的对齐和留白是否一致', trailing: '2 images' })
  })

  it('Glob 省略 path 时展示当前工作目录而不是抽象根目录文案', () => {
    assert.equal(summarizeToolCall('Glob', { pattern: '**/*.tsx' }, {
      projectDir: 'E:\\Agent\\WhyCode',
    }), '“**/*.tsx” · E:\\Agent\\WhyCode')
  })

  it('展开文件与子代理工具时展示指定的完整详情', () => {
    assert.equal(toolCallDetails('EditFile', {
      edits: [{ path: 'a.ts' }, { path: 'a.ts' }, { path: 'b.ts' }],
    }, '已完成', false), 'a.ts\nb.ts')
    assert.equal(toolCallDetails('DeleteFile', {
      paths: ['a.ts', 'b.ts'],
    }, '已删除', false), 'a.ts\nb.ts')
    assert.equal(toolCallDetails('Subagent', {
      description: '核对摘要展示',
    }, '已启动子代理（subagent_id: 12345678-1234-4234-8234-123456789abc）。', false), [
      'subagent_id: 12345678-1234-4234-8234-123456789abc',
      'description: 核对摘要展示',
    ].join('\n'))
    assert.equal(toolCallDetails('SendSubagentMessage', {
      prompt: '继续核对剩余工具',
    }, '已继续', false), '继续核对剩余工具')
  })

  it('为动态工具选择高优先级参数并隐藏密钥', () => {
    assert.equal(summarizeToolCall('Mcp__github__search', {
      path: 'src',
      query: 'tool summary',
      apiKey: 'should-not-render',
      github_pat: 'should-not-render-either',
    }), 'query: tool summary · path: src')
  })

  it('限制动态工具的长文本，避免巨大参数进入常驻 DOM', () => {
    const summary = summarizeToolCall('image_generation', { prompt: 'x'.repeat(1_000) })
    assert.ok(summary.length <= 420)
    assert.equal(summary.endsWith('…'), true)
  })

  it('后台输入只显示真实长度，不泄漏内容或受摘要截断影响', () => {
    const hiddenInput = 's'.repeat(1_000)
    assert.equal(summarizeToolCall('WriteCommandInput', {
      taskId: '12345678-1234-4234-8234-123456789abc',
      input: hiddenInput,
    }), 'task ID 12345678… · 1000 characters')
  })
})
