import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildM1Prompt, buildMainOnlyExecutionPrompt } from '../consensus/prompts.ts'
import { requiresFullConsensus } from '../consensus/orchestrator.ts'
import { buildSystemPrompt } from './system.ts'

describe('通用 Agent 提示约束', () => {
  it('打开项目时仍允许处理非编程问题', () => {
    const prompt = buildSystemPrompt({
      projectDir: 'C:\\work\\demo',
      osPlatform: 'win32',
      homeDir: 'C:\\Users\\tester',
    })

    assert.match(prompt, /通用型桌面 AI Agent/)
    assert.match(prompt, /非项目问题直接回答/)
    assert.match(prompt, /用户主目录：C:\\Users\\tester/)
    assert.match(prompt, /项目外也使用 WriteFile\/EditFile/)
    assert.match(prompt, /不要改用 RunCommand 绕过路径边界/)
    assert.doesNotMatch(prompt, /只讨论与用户项目和编程相关/)
  })

  it('无项目讨论阶段保留协议能力但不声称拥有文件工具', () => {
    const prompt = buildSystemPrompt({
      projectDir: null,
      osPlatform: 'win32',
      discussion: { agentId: 'B', scratchDir: 'C:\\scratch' },
    })

    assert.match(prompt, /可以正常处理通用任务/)
    assert.match(prompt, /必须调用 SubmitProtocolOutput/)
    assert.match(prompt, /不提供文件或命令工具/)
    assert.doesNotMatch(prompt, /原项目目录\*\*只读/)
    assert.doesNotMatch(prompt, /CreateTaskPlan/)
  })

  it('只有 Main 正常执行阶段获得长任务计划规则', () => {
    const prompt = buildSystemPrompt({ projectDir: null, osPlatform: 'win32' })

    assert.match(prompt, /CreateTaskPlan/)
    assert.match(prompt, /UpdateTaskItem/)
    assert.match(prompt, /最终 verification/)
    assert.match(prompt, /简单问答和一步操作不要创建计划/)
  })

  it('M1 模式选择不再把所有任务强制解释为代码问题', () => {
    const prompt = buildM1Prompt('协商一下今天吃什么')

    assert.match(prompt, /通用问题直接围绕问题本身推理/)
    assert.match(prompt, /直接问答/)
    assert.match(prompt, /summary 概括核心结论/)
    assert.match(prompt, /禁止用“用户要求三个 Agent”/)
  })

  it('显式三 Agent 请求在 M1 前由控制面锁定完整共识', () => {
    for (const text of [
      '进行三agent协商，详细看看项目',
      '请让三个 Agent 一起分析',
      '用 3 个模型讨论这个方案',
      '请做三方评审',
    ]) {
      assert.equal(requiresFullConsensus(text), true, text)
    }
    assert.equal(requiresFullConsensus('你一个人简单看看项目'), false)
    assert.match(buildM1Prompt('进行三agent协商', true), /已.*锁定 full_consensus/)
  })

  it('main_only 正式回合必须重新交付完整答案', () => {
    const prompt = buildMainOnlyExecutionPrompt('分析这个项目是做什么的', {
      summary: 'FastAPI 演示项目',
      finalAnswerOrPlan: '分析入口、数据库、鉴权和核心业务。',
    })

    assert.match(prompt, /用户没有看到 M1 的详细内容/)
    assert.match(prompt, /完整、自包含、可独立阅读/)
    assert.match(prompt, /不得使用“如上、前面已经说明、无需重复”/)
    assert.match(prompt, /FastAPI 演示项目/)
  })
})
