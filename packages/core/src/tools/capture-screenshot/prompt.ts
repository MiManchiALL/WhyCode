export const CAPTURE_SCREENSHOT_TOOL_NAME = 'CaptureScreenshot'

export function captureScreenshotPrompt(supportsOriginalDetail: boolean): string {
  return [
    '按明确目标截取指定应用窗口，或截取显示器当前完整或局部画面，用于视觉检查。',
    '检查单个应用或网页时，使用 target=window，并必须提供可唯一匹配目标窗口的 window_title；支持完整标题或唯一子串。目标窗口可以位于后台或被其它窗口遮挡，但必须保持打开且未最小化。',
    '需要观察多个窗口、桌面布局或显示器当前整体状态时，使用 target=screen；不提供 display_id 时使用主显示器。需要截取其中一部分时同时提供 region，否则截取完整显示器。',
    'region 使用相对显示器的 0～1000 标准化坐标，原点位于左上角。',
    '以 target 为准，只提供该目标使用的字段，不要补齐其它可选字段。',
    '视觉修改应遵循“先截图建立基线 → 修改 → 再截图验证”的闭环；没有修改后的新截图，不要声称已经完成视觉验收。',
    '本工具必须独占一个模型步骤，不能与编辑或执行工具放在同一步。',
    supportsOriginalDetail
      ? 'detail=high 适合常规检查；只有小字或像素级验收才使用 detail=original。'
      : '当前模型只开放 detail=high。',
  ].join('\n')
}
