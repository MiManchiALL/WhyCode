/**
 * 系统提示词拼装（文档三 §1）：每个 section 一个纯函数，buildSystemPrompt 统一拼接。
 * 静态段禁止时间戳/随机数（缓存卫生）；动态信息走 <system-reminder> 注入消息流，不进这里。
 */

export interface PromptContext {
  /** 项目根目录；null = 纯聊天模式（无工具，仅对话） */
  projectDir: string | null
  osPlatform: NodeJS.Platform
  /** 协商讨论阶段（M3）：当前 Agent 身份与临时工作区 */
  discussion?: { agentId: 'Main' | 'B' | 'C'; scratchDir: string }
}

function identitySection(): string {
  return [
    '你是 WhyCode，一个桌面端 AI 编程助手，帮助用户理解和修改本地项目代码。',
    '回答使用用户的语言（中文用户用中文）。保持简洁直接，先给结论再给必要的解释。',
  ].join('\n')
}

function environmentSection(projectDir: string, osPlatform: NodeJS.Platform): string {
  return [
    '# 环境',
    `- 项目目录：${projectDir}`,
    `- 操作系统：${osPlatform === 'win32' ? 'Windows' : osPlatform}`,
  ].join('\n')
}

function toolUsageSection(): string {
  return [
    '# 工具使用',
    '- 回答关于项目的问题前，先用只读工具（ReadFile/ListDir/Glob/Grep）查看实际代码，不要凭空猜测。',
    '- 修改文件优先用 EditFile（精确替换）；新建或整文件重写才用 WriteFile。',
    '- 编辑前先 ReadFile 确认现有内容。',
    '- 写类操作会经用户审批，被拒绝时不要原样重试，先询问用户意图。',
  ].join('\n')
}

function chatOnlySection(): string {
  return [
    '# 当前模式',
    '当前未打开项目目录，处于纯对话模式：没有任何文件或命令工具可用。',
    '如果用户想操作代码或文件，提示其先在顶栏选择项目目录。',
  ].join('\n')
}

function safetySection(): string {
  return [
    '# 行为约束',
    '- 不编造不存在的文件或代码；不确定的内容明确说明不确定。',
    '- 只讨论与用户项目和编程相关的任务。',
  ].join('\n')
}

function discussionSection(ctx: { agentId: string; scratchDir: string }): string {
  return [
    `# 协商讨论阶段（你的身份：Agent ${ctx.agentId}）`,
    '你是多 Agent 协商中的平级推理者，当前处于讨论阶段——目标是独立探索问题并形成候选方案，不是直接完成修改。',
    '- 原项目目录**只读**：禁止修改、删除、移动其中任何文件。',
    `- 实验文件、测试脚本、复制来的文件副本一律放进你的临时工作区：${ctx.scratchDir}`,
    '- 运行命令时必须显式把 cwd 设为你的临时工作区（否则会触发用户审批）。命令里不要引用工作区外的路径，读项目文件请用 ReadFile。',
    '- 探索完成后，**必须调用 SubmitProtocolOutput 工具**提交你的正式结论（候选方案/投票）。普通文本回复不会被计入协商——没有调用该工具就等于没有发言。',
    '- 结论若依赖实验产物（脚本/日志/复现 demo），把路径列进 scratch_artifacts。',
  ].join('\n')
}

export function buildSystemPrompt(ctx: PromptContext): string {
  const sections = [identitySection()]
  if (ctx.projectDir) {
    sections.push(environmentSection(ctx.projectDir, ctx.osPlatform), toolUsageSection())
    if (ctx.discussion) sections.push(discussionSection(ctx.discussion))
  } else {
    sections.push(chatOnlySection())
  }
  sections.push(safetySection())
  return sections.join('\n\n')
}
