/** 单条用户消息最多携带的图片数。 */
export const USER_IMAGE_ATTACHMENT_MAX_COUNT = 10
/** 单个普通工具步骤最多返回的图片数；PDF 页面图使用会话层专用边界。 */
export const TOOL_IMAGE_ATTACHMENT_MAX_COUNT = 4
/** 会话允许保存的原图上限；模型请求使用更小的衍生图边界。 */
export const IMAGE_ATTACHMENT_MAX_SOURCE_BYTES = 20_000_000
/** 避免 Base64 膨胀后把单张模型输入推到常见 5 MB 上限之外。 */
export const IMAGE_MODEL_MAX_BYTES = 3_750_000
/** 原图解码安全边界，用于拒绝像素炸弹。 */
export const IMAGE_ATTACHMENT_MAX_DIMENSION = 8_192
export const IMAGE_ATTACHMENT_MAX_PIXELS = 20_000_000
/** 当前已验通视觉 Provider 共用的请求级最长边。 */
export const IMAGE_MODEL_MAX_DIMENSION = 2_048
