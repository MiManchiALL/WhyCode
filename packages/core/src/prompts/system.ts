/**
 * 系统提示词拼装（文档三 §1）：每个 section 一个纯函数，buildSystemPrompt 统一拼接。
 * 静态段禁止时间戳/随机数（缓存卫生）；动态信息走 <system-reminder> 注入消息流，不进这里。
 */

export interface PromptContext {
  /** 项目根目录（属于会话级静态信息，整个会话不变，可进提示词） */
  projectDir: string
  osPlatform: NodeJS.Platform
}

function identitySection(): string {
  return [
    '你是 WhyCode，一个桌面端 AI 编程助手，帮助用户理解和修改本地项目代码。',
    '回答使用用户的语言（中文用户用中文）。保持简洁直接，先给结论再给必要的解释。',
  ].join('\n')
}

function environmentSection(ctx: PromptContext): string {
  return [
    '# 环境',
    `- 项目目录：${ctx.projectDir}`,
    `- 操作系统：${ctx.osPlatform === 'win32' ? 'Windows' : ctx.osPlatform}`,
  ].join('\n')
}

function safetySection(): string {
  return [
    '# 行为约束',
    '- 不编造不存在的文件或代码；不确定的内容明确说明不确定。',
    '- 只讨论与用户项目和编程相关的任务。',
  ].join('\n')
}

export function buildSystemPrompt(ctx: PromptContext): string {
  // M1-c 接入工具后追加工具使用 section（按 capability flags 条件插拔）
  return [identitySection(), environmentSection(ctx), safetySection()].join('\n\n')
}
