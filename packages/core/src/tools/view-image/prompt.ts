export const VIEW_IMAGE_TOOL_NAME = 'ViewImage'

export function viewImagePrompt(): string {
  return `${VIEW_IMAGE_TOOL_NAME} 读取允许范围内的本地 PNG、JPEG 或 WebP 图片，并把安全处理后的视觉内容交给当前模型。路径可相对项目目录或使用已获授权的绝对路径。原图会复制到当前会话，模型请求只使用受限衍生图；不要用 ReadFile、命令或 Base64 代替本工具。`
}
