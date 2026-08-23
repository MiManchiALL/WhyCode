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
      scratch: {
        rootDir: 'C:\\scratch\\session',
        workingDir: 'C:\\scratch\\session\\Main',
      },
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
    assert.match(prompt, /临时工作区：C:\\scratch\\session\\Main/)
    assert.match(prompt, /非交付脚本、日志、下载或转换中间物及其它临时产物放在临时工作区/)
    assert.match(prompt, /修改或评价代码前先读取相关文件和调用点/)
    assert.match(prompt, /在形成结论或采取行动前，识别对结果有决定作用的事实/)
    assert.match(prompt, /当前状态、近期变化、是否仍然有效、实际覆盖范围或可追溯出处/)
    assert.match(prompt, /模型记忆不能替代这类核实/)
    assert.match(prompt, /已有直接证据足以支撑结论，则无需调用工具/)
    assert.doesNotMatch(prompt, /评估当前依据是否充分|存在实质不确定性/)
    assert.match(
      prompt,
      /相互独立的只读工具尽可能优先并行化而不是顺序工具调用，这有助于减少往返延迟/,
    )
    assert.match(prompt, /一次调用可提交一处或多处精确替换/)
    assert.doesNotMatch(prompt, /BatchEdit/)
    assert.match(prompt, /DeleteFile\/MoveFile/)
    assert.match(prompt, /文件副作用没有精确检查点/)
    assert.match(prompt, /首次调用前简短说明立即要做什么/)
    assert.match(prompt, /长任务包含多次工具调用或多个阶段/)
    assert.match(prompt, /有新进展的合理间隔用 1～2 句话概括已确认进度和接下来方向/)
    assert.match(prompt, /不重复未变化的状态/)
    assert.match(prompt, /进度文字后在同一步继续调用工具/)
    assert.match(prompt, /全部工具结束后再交付完整、自包含的最终回答/)
    assert.match(prompt, /不用“见上文”或前序进度代替最终结果/)
    assert.match(prompt, /长安装、构建和测试使用 StartCommand 的默认等待模式/)
    assert.match(prompt, /开发服务器、watch.*detach=true/)
    assert.match(prompt, /用户只要求分析、解释、审查或诊断时，只给出分析/)
    assert.match(prompt, /不要原样重试，也不要因一次失败放弃仍可行的方案/)
    assert.match(prompt, /不要额外扩展功能、顺手重构或添加配置/)
    assert.match(prompt, /发现陌生文件、分支、锁或配置时先调查来源/)
    assert.match(prompt, /区分已观察事实、推断和准备执行的动作/)
  })

  it('Fork 后明确把历史临时路径映射到新会话副本', () => {
    const prompt = buildSystemPrompt({
      projectDir: 'C:\\work\\demo',
      osPlatform: 'win32',
      scratch: {
        rootDir: 'C:\\scratch\\target',
        workingDir: 'C:\\scratch\\target\\Main',
        forkSourceRootDir: 'C:\\scratch\\source',
      },
    })

    assert.match(
      prompt,
      /Fork 临时路径映射：C:\\scratch\\source → C:\\scratch\\target（来源内容已按相对路径复制；历史中的其它会话 scratch 路径也按其根下相对路径映射到当前根，后续只使用当前路径）/,
    )
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
    assert.equal(prompt.match(/C:\\scratch/gu)?.length, 1)
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
    assert.match(prompt, /UpdateTaskItem/)
    assert.match(prompt, /CloseTaskPlan/)
    assert.doesNotMatch(prompt, /ReplaceTaskPlan|AddTaskItem/)
    assert.match(prompt, /始终优先理解最新真实用户消息/)
    assert.match(prompt, /以最新摘要、TaskState 和最近消息作为连续上下文/)
    assert.match(prompt, /不要重做已经完成的工作/)
    assert.match(prompt, /none.*interrupted.*engaged.*dormant/)
    assert.match(prompt, /steering/)
    assert.match(prompt, /暂缓时自然结束 run/)
    assert.match(prompt, /interrupted 或 dormant 都先 ResumeTaskPlan/)
    assert.match(prompt, /定向扫描关键文件形成整体认知/)
    assert.match(prompt, /3～7 个结果导向的宏观里程碑/)
    assert.match(prompt, /不写或输出详细子步骤/)
    assert.match(prompt, /创建后全部为 pending/)
    assert.match(prompt, /先用 UpdateTaskItem 显式设为 in_progress/)
    assert.match(prompt, /不自动开始下一项/)
    assert.match(prompt, /原子增删改排当前或未来项/)
    assert.match(prompt, /独立新目标在后续步骤重新扫描后 Create/)
    assert.match(prompt, /不保留旧计划历史/)
    assert.match(prompt, /正常最终答复会由会话协议自动结束当前计划/)
    assert.match(prompt, /用户停止、等待用户回答或等待已登记的后台唤醒时保留计划/)
    assert.doesNotMatch(prompt, /blocked_reason|CloseTaskPlan\(completed\)|CloseTaskPlan\(abandoned\)/)
    assert.doesNotMatch(prompt, /PauseTaskPlan/)
  })

  it('父代理并行委派后继续不重叠工作，并保留最终综合责任', () => {
    const prompt = buildSystemPrompt({
      projectDir: 'C:\\work\\demo',
      osPlatform: 'win32',
      subagents: {
        definitions: [],
        diagnostics: [],
        modelContext: '<available_subagents>\n</available_subagents>',
      },
    })

    assert.match(prompt, /不要与子代理重复同一工作/)
    assert.match(prompt, /多个互不依赖的委派在同一模型步骤并行启动/)
    assert.match(prompt, /优先继续用户目标中不依赖且不重叠的工作/)
    assert.match(prompt, /每个终态到达时把结果作为阶段进展/)
    assert.match(prompt, /当前 turn 仍有未交付激活时，不得猜测、抢跑或给出最终结论/)
    assert.match(prompt, /没有其它工作就等待/)
    assert.match(prompt, /WhyCode 会保持本 turn 并允许用户插话/)
    assert.match(prompt, /全部终态交付后，父代理再综合、必要核验并最终答复/)
  })

  it('子代理只看到自己的身份、独立计划与固定工具档位', () => {
    const prompt = buildSystemPrompt({
      projectDir: 'C:\\work\\demo',
      osPlatform: 'win32',
      scratch: {
        rootDir: 'C:\\scratch\\parent\\subagents\\child',
        workingDir: 'C:\\scratch\\parent\\subagents\\child',
      },
      subagent: {
        id: '11111111-1111-4111-8111-111111111111',
        name: '探索代理',
        description: '只读调查',
        instructions: '核对证据后给出结论。',
        toolNames: ['ReadFile', 'Grep', 'WebSearch'],
      },
    })

    assert.match(prompt, /# 子代理身份：探索代理/)
    assert.match(prompt, /不得假定未提供的父会话背景/)
    assert.match(prompt, /直接推进到可交付结论/)
    assert.match(prompt, /需要计划时可使用你自己的任务计划/)
    assert.match(prompt, /区分观察与推断/)
    assert.match(prompt, /自动交付终态/)
    assert.match(prompt, /CreateTaskPlan/)
    assert.doesNotMatch(prompt, /<available_subagents>/)
    assert.doesNotMatch(prompt, /AskUserQuestion|SendSubagentMessage|StartCommand/)
    assert.doesNotMatch(prompt, /EditFile|WriteFile|DeleteFile|MoveFile|RunCommand/)
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
