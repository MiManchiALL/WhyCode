import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { summarizeToolCall } from './tool-call-summary.ts'

describe('工具卡片关键参数摘要', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['ReadFile', { path: 'src/app.ts', offset: 11, limit: 20 }, 'src/app.ts · 第 11–30 行'],
    ['ListDir', { path: 'src' }, 'src'],
    ['Glob', { pattern: '**/*.tsx', path: 'apps' }, '“**/*.tsx” · apps'],
    ['Grep', { pattern: 'summarizeInput', path: 'apps', include: '*.tsx' }, '“summarizeInput” · apps · 文件 *.tsx'],
    ['WriteFile', { path: 'src/new.ts', content: 'hidden' }, 'src/new.ts'],
    ['EditFile', { edits: [{ path: 'a.ts' }, { path: 'a.ts' }, { path: 'b.ts' }] }, 'a.ts 等 2 个文件 · 3 处修改'],
    ['DeleteFile', { paths: ['a.ts', 'b.ts'] }, 'a.ts 等 2 个文件'],
    ['MoveFile', { source: 'old.ts', destination: 'new.ts' }, 'old.ts → new.ts'],
    ['RunCommand', { command: 'pnpm test', cwd: 'E:\\Agent\\WhyCode', runInBackground: true, wakeOnCompletion: true }, 'pnpm test · 后台完成后唤醒 · 目录 E:\\Agent\\WhyCode'],
    ['ListCommands', {}, '当前会话'],
    ['GetCommandOutput', { taskId: '12345678-1234-4234-8234-123456789abc', offset: 4096 }, '任务 12345678… · 偏移 4096'],
    ['WriteCommandInput', { taskId: '12345678-1234-4234-8234-123456789abc', input: 'yes', closeAfterWrite: true }, '任务 12345678… · 写入 3 字符 · 写入后关闭 stdin'],
    ['StopCommand', { taskId: '12345678-1234-4234-8234-123456789abc' }, '任务 12345678…'],
    ['WebSearch', { query: ['WhyCode', 'agent UI'], domains: ['github.com'], recency: 'week' }, '“WhyCode” 等 2 个查询 · github.com · 时间 week'],
    ['WebFetch', { url: 'https://example.com/', offset: 101, limit: 100 }, 'https://example.com/ · 第 101–200 行'],
    ['WebFind', { url: 'https://example.com/', pattern: 'AgentSession' }, '“AgentSession” · https://example.com/'],
    ['ViewImage', { path: 'screen.png', detail: 'original' }, 'screen.png · 原图'],
    ['AnalyzeImage', { question: '按钮是否对齐？', attachmentIds: ['a', 'b'] }, '“按钮是否对齐？” · 2 张图片'],
    ['CaptureScreenshot', { target: 'window', window_title: 'WhyCode' }, '窗口 · “WhyCode”'],
    ['CaptureScreenshot', { target: 'region', region: { x: 10, y: 20, width: 300, height: 200 } }, '区域 10,20 300×200'],
    ['ReadPdf', { sourceType: 'path', sourceValue: 'guide.pdf', startPage: 3, pageCount: 4 }, 'guide.pdf · 第 3–6 页'],
    ['BuildOfficeArtifact', { outputPath: 'report.pptx', format: 'pptx', mode: 'template' }, 'report.pptx · PPTX · 模板模式'],
    ['InspectOffice', { path: 'report.xlsx', view: 'objects', sheetName: 'Summary', range: 'A1:F20', startUnit: 21, unitCount: 10 }, 'report.xlsx · objects · 工作表 Summary · A1:F20 · 第 21–30 单元'],
    ['RenderOffice', { path: 'report.pptx', view: 'overview', startPage: 1, pageCount: 12 }, 'report.pptx · 总览 · 第 1–12 页'],
    ['Skill', { skillId: `skill:${'a'.repeat(64)}`, resourcePath: 'references/api.md' }, 'references/api.md · aaaaaaaa…'],
    ['AskUserQuestion', { questions: [{ question: '保留还是替换？' }, { question: '是否推送？' }] }, '“保留还是替换？” · 2 个问题'],
    ['CreateTaskPlan', { goal: '完成工具摘要优化', items: [{}, {}, {}] }, '“完成工具摘要优化” · 3 个里程碑'],
    ['ResumeTaskPlan', { plan_id: '12345678-1234-4234-8234-123456789abc' }, '计划 12345678…'],
    ['UpdateTaskItem', { item_id: 'T2', status: 'completed', changes: [{ action: 'edit' }] }, 'T2 → 已完成 · 1 项计划调整'],
    ['CloseTaskPlan', {}, '当前计划'],
    ['Subagent', { agent_id: 'explore', description: '检查工具摘要', prompt: 'hidden' }, '“检查工具摘要” · explore'],
    ['SendSubagentMessage', { subagent_id: '12345678-1234-4234-8234-123456789abc', prompt: '继续核对测试' }, '子代理 12345678… · “继续核对测试”'],
    ['ListSubagents', {}, '当前会话'],
    ['ToolSearch', { query: 'GitHub file contents read', max_results: 5 }, '“GitHub file contents read” · 最多 5'],
    ['SubmitProtocolOutput', { candidate: { summary: '采用统一摘要器' } }, '“采用统一摘要器”'],
  ]

  for (const [toolName, input, expected] of cases) {
    it(`${toolName} 展示动作所需的关键内容`, () => {
      assert.equal(summarizeToolCall(toolName, input), expected)
    })
  }

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
    }), '任务 12345678… · 写入 1000 字符')
  })
})
