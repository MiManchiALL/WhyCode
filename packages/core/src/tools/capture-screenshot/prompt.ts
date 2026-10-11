export const CAPTURE_SCREENSHOT_TOOL_NAME = 'CaptureScreenshot'

export function captureScreenshotPrompt(supportsOriginalDetail: boolean): string {
  return [
    '检查单个应用用 target=window 和唯一匹配的 window_title，无需前置、改层级或手动恢复窗口。Windows 自动临时透明恢复最小化/隐藏窗口，结束后还原；应用未打开时可提供 application_path 隐藏启动，截完保留最小化。应用自行弹窗可能打断静默，不承诺零干扰。',
    '仅检查桌面整体时用 target=screen；display_id 默认主屏，region 为左上原点的 0～1000 标准化裁剪区域。只提供所选 target 的字段。',
    '视觉修改应遵循“先截图建立基线 → 修改 → 再截图验证”的闭环；没有修改后的新截图，不要声称已经完成视觉验收。',
    '本工具必须独占一个模型步骤，不能与编辑或执行工具放在同一步。',
    supportsOriginalDetail
      ? 'detail=high 适合常规检查；只有小字或像素级验收才使用 detail=original。'
      : '当前模型只开放 detail=high。',
  ].join('\n')
}
