/**
 * 附件消息的宿主兜底正文。纯图片输入必须保留空正文，让模型直接接收图片；
 * PDF 仍需要显式正文来触发文档读取工作流。
 */
export function attachmentFallbackText(imageCount: number, pdfCount: number): string {
  if (imageCount > 0 && pdfCount > 0) return '请分析这些附件。'
  if (pdfCount > 0) return '请分析这些 PDF。'
  return ''
}
