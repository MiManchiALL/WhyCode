export const CAPTURE_SCREENSHOT_TOOL_NAME = 'CaptureScreenshot'

export function captureScreenshotPrompt(supportsOriginalDetail: boolean): string {
  return [
    '截取当前桌面、WhyCode 窗口或屏幕区域，并把截图作为视觉结果交给 Main。',
    '验证单个外部应用或网页时，优先使用 target=window 并提供 window_title；本地 HTML 可从 <title> 取得窗口标题，这样截图不依赖当前前台焦点。',
    'screen 默认主显示器，只用于整屏或跨窗口观察；screen/region 采集时宿主会自动排除 WhyCode。',
    'window 不传 window_title 时专门截取 WhyCode，也可用唯一标题或子串选择其它可见窗口。',
    'region 的坐标相对所选显示器左上角，单位为逻辑像素（DIP）。',
    '以 target 为准，只提供该目标使用的字段，不要补齐其它可选字段。',
    '视觉修改应遵循“先截图建立基线 → 修改 → 再截图验证”的闭环；没有修改后的新截图，不要声称界面已经视觉验收。',
    '本工具必须独占一个模型步骤，不能与编辑或执行工具放在同一步。',
    supportsOriginalDetail
      ? 'detail=high 适合常规检查；只有小字或像素级验收才用 detail=original。'
      : '当前模型只开放 detail=high。',
  ].join('\n')
}
