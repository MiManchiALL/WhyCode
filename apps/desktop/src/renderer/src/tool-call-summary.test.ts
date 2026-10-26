import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  summarizeToolCall,
  summarizeToolCallParts,
  toolCallDetails,
} from '../../shared/tool-call-summary.ts'

it('长命令结果展示预览、完整日志路径和失败诊断，复制文本不暴露 JSON 包装', () => {
  const data = JSON.stringify({ type: 'command-output', output: '最后一行😀\r\n', totalBytes: 100_000,
    totalLines: 5000, fullOutputPath: 'C:\\scratch\\Main\\command-output\\test.log', diagnostic: '[退出码 1]' })
  for (const isError of [false, true]) {
    const details = toolCallDetails('RunCommand', { command: 'build' }, data, isError)!
    assert.match(details, /最后一行😀\r\n/)
    assert.ok(details.includes('完整日志：C:\\scratch\\Main\\command-output\\test.log'))
    assert.match(details, /\[退出码 1\]/)
    assert.doesNotMatch(details, /"type":"command-output"/)
  }
})

describe('工具卡片关键参数摘要', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['ReadFile', { path: 'src/app.ts', offset: 11, limit: 20 }, 'src/app.ts · lines 11–30'],
    ['ListDir', { path: 'src' }, 'src'],
    ['Glob', { pattern: '**/*.tsx', path: 'apps' }, '“**/*.tsx” · apps'],
    ['Grep', { pattern: 'summarizeInput', path: 'apps', include: '*.tsx' }, '“summarizeInput” · apps · include *.tsx'],
    ['WriteFile', { path: 'src/new.ts', content: 'hidden' }, 'src/new.ts'],
    ['EditFile', { edits: [{ path: 'a.ts' }, { path: 'a.ts' }, { path: 'b.ts' }] }, '2 files'],
    ['DeleteFile', { paths: ['a.ts', 'b.ts'] }, '2 files'],
    ['RunCommand', { command: 'pnpm test', cwd: 'E:\\Agent\\WhyCode', runInBackground: true, wakeOnCompletion: true }, 'pnpm test'],
    ['ManageCommand', { action: 'list' }, 'list'],
    ['ManageCommand', { action: 'read', taskId: '12345678-1234-4234-8234-123456789abc', offset: 4096 }, 'read · task ID 12345678… · offset 4096'],
    ['ManageCommand', { action: 'write', taskId: '12345678-1234-4234-8234-123456789abc', input: 'yes' }, 'write · task ID 12345678… · 3 characters'],
    ['ManageCommand', { action: 'close', taskId: '12345678-1234-4234-8234-123456789abc' }, 'close · task ID 12345678…'],
    ['ManageCommand', { action: 'close', taskId: '12345678-1234-4234-8234-123456789abc', input: 'last\n' }, 'close · task ID 12345678… · 5 characters'],
    ['ManageCommand', { action: 'stop', taskId: '12345678-1234-4234-8234-123456789abc' }, 'stop · task ID 12345678…'],
    ['WebSearch', { query: ['WhyCode', 'agent UI'], domains: ['github.com'], recency: 'week' }, 'WhyCode agent UI · past week'],
    ['WebFetch', { url: 'https://example.com/', offset: 101, limit: 100 }, 'https://example.com/ · lines 101–200'],
    ['WebFind', { url: 'https://example.com/', pattern: 'AgentSession' }, '“AgentSession” · https://example.com/'],
    ['ReadFile', { path: 'screen.png' }, 'screen.png · high'],
    ['ReadFile', { path: 'diagram.svg', offset: 1, limit: 40 }, 'diagram.svg · lines 1–40'],
    ['AnalyzeImage', { question: '按钮是否对齐？', attachmentIds: ['a', 'b'] }, '按钮是否对齐？ · 2 images'],
    ['CaptureScreenshot', { target: 'window', window_title: 'WhyCode' }, 'window · WhyCode'],
    ['CaptureScreenshot', { target: 'screen' }, 'screen'],
    ['CaptureScreenshot', { target: 'screen', region: { x: 100, y: 200, width: 300, height: 200 } }, 'screen · region 300×200'],
    ['ReadFile', { path: 'guide.pdf', pages: '3-6' }, 'guide.pdf · pages 3–6'],
    ['ReadFile', { path: 'attachment://22222222-2222-4222-8222-222222222222', pages: '21-40' }, 'attachment 22222222… · pages 21–40'],
    ['AskUserQuestion', { questions: [{ question: '保留还是替换？' }, { question: '是否推送？' }] }, '2 questions'],
    ['CreateTaskPlan', { goal: '完成工具摘要优化', items: [{}, {}, {}] }, '3 milestones'],
    ['ResumeTaskPlan', { plan_id: '12345678-1234-4234-8234-123456789abc' }, 'plan ID 12345678…'],
    ['UpdateTaskItem', { item_id: 'T2', status: 'completed', changes: [{ action: 'edit' }] }, 'T2 → complete · 1 plan change'],
    ['CloseTaskPlan', { plan_id: '12345678-1234-4234-8234-123456789abc' }, 'plan ID 12345678…'],
    ['Subagent', { name: 'explore', description: '检查工具摘要', prompt: 'hidden' }, 'explore'],
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

  it('为搜索时间与图片数量保留独立的摘要参数', () => {
    assert.deepEqual(summarizeToolCallParts('WebSearch', {
      query: ['今日头条', '热点新闻'],
      recency: 'day',
    }), { parts: [{ text: '今日头条 热点新闻' }, { text: 'past day', fixed: true }], separator: ' · ' })
    assert.deepEqual(summarizeToolCallParts('AnalyzeImage', {
      question: '逐项检查界面中的对齐和留白是否一致',
      attachmentIds: ['a', 'b'],
    }), { parts: [{ text: '逐项检查界面中的对齐和留白是否一致' }, { text: '2 images', fixed: true }], separator: ' · ' })
  })

  it('长文件路径不吞掉行数、页码或图片精度，未传行数时不补造范围', () => {
    const directory = `E:/workspace/${'very-long-folder/'.repeat(20)}`
    const cases: Array<[Record<string, unknown>, string[]]> = [
      [{ path: `${directory}code.ts`, offset: 1, limit: 80 }, ['lines 1–80']],
      [{ path: `${directory}code.ts`, offset: 100 }, ['from line 100']],
      [{ path: `${directory}code.ts`, limit: 100 }, ['first 100 lines']],
      [{ path: `${directory}code.ts` }, []],
      [{ path: `${directory}image.png` }, ['high']],
      [{ path: `${directory}guide.pdf`, pages: '21-40' }, ['pages 21–40']],
      [{ path: `${directory}guide.pdf` }, ['from page 1']],
    ]
    for (const [input, suffix] of cases) {
      const summary = summarizeToolCallParts('ReadFile', input)
      assert.equal(summary.parts[0]?.text.endsWith('…'), true)
      assert.deepEqual(summary.parts.slice(1), suffix.map(text => ({ text, fixed: true })))
    }
  })

  it('多个长参数分别有界，末项参数不会被总长度预算删除', () => {
    const summary = summarizeToolCallParts('Grep', {
      pattern: 'pattern · literal'.repeat(30),
      path: `/${'directory/'.repeat(30)}`,
      include: '*.tsx',
    })
    assert.equal(summary.parts.length, 3)
    assert.match(summary.parts[0]!.text, /pattern · literal/)
    assert.equal(summary.parts[0]?.text.endsWith('…'), true)
    assert.equal(summary.parts[1]?.text.endsWith('…'), true)
    assert.equal(summary.parts[2]?.text, 'include *.tsx')
    assert.ok(summary.parts.map(part => part.text).join(summary.separator).length <= 420)
  })

  it('其它多参数工具和动态工具保留各参数边界', () => {
    const cases: Array<[string, Record<string, unknown>, string[]]> = [
      ['Glob', { pattern: '**/*.tsx', path: 'apps' }, ['“**/*.tsx”', 'apps']],
      ['WebFetch', { url: 'https://example.com/', offset: 1, limit: 20 }, ['https://example.com/', 'lines 1–20']],
      ['WebFind', { pattern: 'query', url: 'https://example.com/' }, ['“query”', 'https://example.com/']],
      ['ToolSearch', { query: 'search', max_results: 5 }, ['“search”', 'max results 5']],
      ['Mcp__files__search', { query: 'query · literal', path: 'apps', apiKey: 'hidden' }, ['query: query · literal', 'path: apps']],
    ]
    for (const [tool, input, expected] of cases) {
      assert.deepEqual(summarizeToolCallParts(tool, input).parts.map(part => part.text), expected)
    }
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
    assert.equal(summarizeToolCall('ManageCommand', { action: 'write',
      taskId: '12345678-1234-4234-8234-123456789abc',
      input: hiddenInput,
    }), 'write · task ID 12345678… · 1000 characters')
  })
})
