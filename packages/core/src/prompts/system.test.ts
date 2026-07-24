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
    assert.doesNotMatch(prompt, /当前日期|当前本机时间/)
    assert.match(prompt, /尤其擅长代码编写、代码理解、调试及其他编程相关任务/)
    assert.doesNotMatch(prompt, /软件开发是你的核心专长/)
    assert.match(prompt, /非项目问题直接回答/)
    assert.match(prompt, /用户主目录：C:\\Users\\tester/)
    assert.match(prompt, /项目外文件同样使用专用文件工具/)
    assert.match(prompt, /不要改用 RunCommand 绕过路径边界/)
    assert.match(prompt, /命令副作用不提供回滚/)
    assert.match(prompt, /多处相关精确替换用 BatchEdit/)
    assert.match(prompt, /DeleteFile\/MoveFile/)
    assert.match(prompt, /开发服务器、watch、长测试.*StartCommand/)
    assert.doesNotMatch(prompt, /只讨论与用户项目和编程相关/)
  })

  it('系统提示词不含动态时间并保持稳定', () => {
    const context = {
      projectDir: 'C:\\work\\demo',
      osPlatform: 'win32' as const,
    }

    assert.equal(buildSystemPrompt(context), buildSystemPrompt(context))
    assert.doesNotMatch(buildSystemPrompt(context), /\d{4}-\d{2}-\d{2}/u)
  })

  it('自定义 System 可以稳定追加或完整替换内置提示词', () => {
    const context = {
      projectDir: 'C:\\work\\demo',
      osPlatform: 'win32' as const,
    }
    const builtIn = buildSystemPrompt(context)

    assert.equal(
      buildSystemPrompt(context, { mode: 'append', content: '用户追加规则' }),
      `${builtIn}\n\n用户追加规则`,
    )
    assert.equal(
      buildSystemPrompt(context, { mode: 'replace', content: '完全自定义 System' }),
      '完全自定义 System',
    )
  })

  it('协商讨论阶段不向模型宣传已物理移除的后台命令工具', () => {
    const prompt = buildSystemPrompt({
      projectDir: 'C:\\work\\demo',
      osPlatform: 'win32',
      discussion: { agentId: 'B', scratchDir: 'C:\\scratch' },
    })

    assert.doesNotMatch(prompt, /StartCommand/)
    assert.doesNotMatch(prompt, /GetCommandOutput/)
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
    assert.match(prompt, /ResumeTaskPlan/)
    assert.match(prompt, /ReplaceTaskPlan/)
    assert.match(prompt, /UpdateTaskItem/)
    assert.match(prompt, /最终验证通过/)
    assert.match(prompt, /始终优先理解最新真实用户消息/)
    assert.match(prompt, /none.*blocked.*engaged.*dormant/)
    assert.match(prompt, /steering/)
    assert.match(prompt, /暂缓时自然结束 run/)
    assert.match(prompt, /无论 blocked 或 dormant 都先 ResumeTaskPlan/)
    assert.match(prompt, /复杂多步骤任务可先只读检查，但实质执行前必须建立或接合计划/)
    assert.match(prompt, /有 active 用 ReplaceTaskPlan，无 active 用 CreateTaskPlan/)
    assert.match(prompt, /历史复杂目标重新规划后/)
    assert.match(prompt, /禁止 Close\+Create/)
    assert.match(prompt, /仅提出或要求开始另一个目标不代表放弃当前计划/)
    assert.match(prompt, /指定恢复某历史目标才算授权/)
    assert.doesNotMatch(prompt, /PauseTaskPlan/)
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
