export const VIEW_IMAGE_TOOL_NAME = 'ViewImage'

export function viewImagePrompt(supportsOriginalDetail: boolean): string {
  const detail = supportsOriginalDetail
    ? 'detail=high 使用受限高细节衍生图；仅在确需逐像素/小字检查时用 detail=original（不缩放，仍受 20 MB 上限）。'
    : '当前模型只开放 detail=high；不要请求 original。'
  return `${VIEW_IMAGE_TOOL_NAME} 读取允许范围内的本地 PNG、JPEG 或 WebP 图片，并把视觉内容交给当前模型。路径可相对项目目录或使用已获授权的绝对路径。${detail}region 坐标基于自动纠正方向后的源图像素；工具会返回模型像素到源图的映射。原图会复制到当前会话，Base64 不会持久化；不要用 ReadFile、命令或 Base64 代替本工具。`
}
