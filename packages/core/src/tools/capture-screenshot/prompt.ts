export const CAPTURE_SCREENSHOT_TOOL_NAME = 'CaptureScreenshot'

export function captureScreenshotPrompt(supportsOriginalDetail: boolean): string {
  return [
    '检查单个应用用 target=window 和完整的 window_title；未找到或重名时按候选选择 window_id，无需前置、改层级或手动恢复窗口。Windows 截完还原原有显示状态。应用未打开时可提供 application_path；本次只后台启动、不截图，随后不带路径再次调用截图。',
    '仅检查桌面整体时用 target=screen；display_id 默认主屏，region 为左上原点的 0～1000 标准化裁剪区域。只提供所选 target 的字段。',
    '视觉修改应遵循“先截图建立基线 → 修改 → 再截图验证”的闭环；没有修改后的新截图，不要声称已经完成视觉验收。',
    supportsOriginalDetail
      ? 'detail=high 适合常规检查；只有小字或像素级验收才使用 detail=original。'
      : '当前模型只开放 detail=high。',
  ].join('\n')
}
