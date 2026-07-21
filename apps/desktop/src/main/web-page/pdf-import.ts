import {
  PdfProcessingError,
  WebPageError,
  pdfAttachmentSchema,
  preparePdfAttachmentImport,
  type PdfAttachment,
  type PdfProcessor,
} from '@whycode/core'
import type { WebPdfDocument } from './network.ts'

export async function importWebPdfDocument(
  document: WebPdfDocument,
  options: {
    attachmentDirectory: string
    sessionId: string
    processor: PdfProcessor
  },
  abortSignal: AbortSignal,
): Promise<PdfAttachment> {
  if (abortSignal.aborted) throw new WebPageError('网页读取已取消')
  try {
    const transaction = await preparePdfAttachmentImport(
      [{ kind: 'bytes', bytes: document.bytes, name: webPdfName(document.finalUrl) }],
      options.attachmentDirectory,
      options.sessionId,
      options.processor,
      abortSignal,
    )
    try {
      await transaction.commit()
      if (abortSignal.aborted) {
        await transaction.rollback()
        throw new WebPageError('网页读取已取消')
      }
      return pdfAttachmentSchema.parse({
        ...transaction.attachments[0],
        origin: 'web',
      })
    } catch (error) {
      await transaction.rollback().catch(() => {})
      throw error
    }
  } catch (error) {
    if (error instanceof WebPageError) throw error
    if (error instanceof PdfProcessingError) throw pdfWebPageError(error)
    throw new WebPageError('远程 PDF 处理失败')
  }
}

function webPdfName(url: string): string {
  try {
    const raw = new URL(url).pathname.split('/').at(-1) || 'document.pdf'
    const decoded = decodeURIComponent(raw)
    return decoded.toLowerCase().endsWith('.pdf') ? decoded : `${decoded}.pdf`
  } catch {
    return 'document.pdf'
  }
}

function pdfWebPageError(error: PdfProcessingError): WebPageError {
  if (error.code === 'aborted') return new WebPageError('网页读取已取消')
  if (error.code === 'timeout') return new WebPageError('远程 PDF 解析超时')
  if (error.code === 'password-protected') return new WebPageError('远程 PDF 已加密，无法读取')
  if (error.code === 'too-large') return new WebPageError('远程 PDF 超过 50 MB 安全上限')
  if (error.code === 'too-many-pages') return new WebPageError('远程 PDF 超过 1000 页安全上限')
  if (error.code === 'empty' || error.code === 'corrupted') {
    return new WebPageError('远程 PDF 已损坏或格式无效')
  }
  return new WebPageError('远程 PDF 处理失败')
}
