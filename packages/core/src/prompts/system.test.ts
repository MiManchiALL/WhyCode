import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildM1Prompt, buildMainOnlyExecutionPrompt } from '../consensus/prompts.ts'
import { requiresFullConsensus } from '../consensus/orchestrator.ts'
import { buildSystemPrompt } from './system.ts'

describe('通用 Agent 提示约束', () => {
  it('普通执行提示词保持主动协作、精确工具路由和最小改动约束', () => {
    const prompt = buildSystemPrompt({
      projectDir: 'C:\\work\\demo',
      osPlatform: 'win32',
      homeDir: 'C:\\Users\\tester',
    })

    assert.match(prompt, /通用型桌面 AI Agent/)
    assert.match(prompt, /持续推进任务，直到用户目标完成/)
    assert.match(
      prompt,
      /当用户与你交谈时，他们应该感觉到自己在与另一个主体性接触，这正是与你交谈感觉真实而独特的原因。/,
    )
    assert.doesNotMatch(prompt, /当前日期|当前本机时间/)
    assert.doesNotMatch(prompt, /非项目问题直接回答|无故读取项目/)
    assert.match(prompt, /用户主目录：C:\\Users\\tester/)
    assert.match(prompt, /修改或评价代码前先读取相关文件和调用点/)
    assert.match(
      prompt,
      /相互独立的只读工具尽可能优先并行化而不是顺序工具调用，这有助于减少往返延迟/,
    )
    assert.match(prompt, /一次调用可提交一处或多处精确替换/)
    assert.doesNotMatch(prompt, /BatchEdit/)
    assert.match(prompt, /DeleteFile\/MoveFile/)
    assert.match(prompt, /文件副作用没有精确检查点/)
    assert.match(prompt, /长安装、构建和测试使用 StartCommand 的默认等待模式/)
    assert.match(prompt, /开发服务器、watch.*detach=true/)
    assert.match(prompt, /用户只要求分析、解释、审查或诊断时，只给出分析/)
    assert.match(prompt, /不要原样重试，也不要因一次失败放弃仍可行的方案/)
    assert.match(prompt, /不要额外扩展功能、顺手重构或添加配置/)
    assert.match(prompt, /发现陌生文件、分支、锁或配置时先调查来源/)
    assert.match(prompt, /区分已观察事实、推断和准备执行的动作/)
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
    assert.match(prompt, /未限定在临时工作区内的命令会被工具层拒绝/)
  })

  it('讨论阶段始终获得项目只读边界与独立临时工作区', () => {
    const prompt = buildSystemPrompt({
      projectDir: 'C:\\work\\demo',
      osPlatform: 'win32',
      discussion: { agentId: 'B', scratchDir: 'C:\\scratch' },
    })

    assert.match(prompt, /必须调用 SubmitProtocolOutput/)
    assert.match(prompt, /原项目目录\*\*只读/)
    assert.match(prompt, /C:\\scratch/)
    assert.doesNotMatch(prompt, /CreateTaskPlan/)
  })

  it('只有 Main 正常执行阶段获得长任务计划规则', () => {
    const prompt = buildSystemPrompt({ projectDir: 'C:\\work\\demo', osPlatform: 'win32' })

    assert.match(prompt, /# 环境/)
    assert.match(prompt, /# 工具使用/)
    assert.match(prompt, /# 任务计划/)
    assert.doesNotMatch(prompt, /纯对话模式|当前未打开项目目录/)
    assert.match(prompt, /CreateTaskPlan/)
    assert.match(prompt, /ResumeTaskPlan/)
    assert.match(prompt, /ReplaceTaskPlan/)
    assert.match(prompt, /UpdateTaskItem/)
    assert.match(prompt, /最终验证通过/)
    assert.match(prompt, /始终优先理解最新真实用户消息/)
    assert.match(prompt, /以最新摘要、TaskState 和最近消息作为连续上下文/)
    assert.match(prompt, /不要重做已经完成的工作/)
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
