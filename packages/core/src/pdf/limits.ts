/** 单条消息最多携带的 PDF 数量；PDF 仅注入引用，不会整份进入模型上下文。 */
export const PDF_ATTACHMENT_MAX_COUNT = 4
/** 单个会话 PDF 原文件上限。 */
export const PDF_ATTACHMENT_MAX_SOURCE_BYTES = 50_000_000
/** 单条混合消息内全部 PDF 的总字节上限。 */
export const PDF_ATTACHMENT_MAX_TOTAL_BYTES = 100_000_000
/** 按需分页允许保留的大文档上限。 */
export const PDF_ATTACHMENT_MAX_PAGES = 1_000

export const PDF_TEXT_DEFAULT_PAGES = 5
export const PDF_TEXT_MAX_PAGES = 20
export const PDF_TEXT_MAX_CHARS = 60_000
export const PDF_VISUAL_MAX_PAGES = 4
/** 单次请求自动展开的小 PDF 页面总预算；超出后仍保留 ReadPdf 按需读取。 */
export const PDF_INLINE_VISUAL_MAX_PAGES = PDF_VISUAL_MAX_PAGES
/** 自动展开页面图的解码后字节总预算。 */
export const PDF_INLINE_VISUAL_MAX_BYTES = 16_000_000
