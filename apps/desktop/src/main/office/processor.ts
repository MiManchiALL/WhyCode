import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OFFICE_RENDER_MAX_PAGES,
  OfficeProcessingError,
  type OfficeInspection,
  type OfficeInspectOptions,
  type OfficeProcessor,
  type OfficeRenderOptions,
  type OfficeRenderResult,
} from '@whycode/core/office'
import type { PdfProcessor } from '@whycode/core/pdf'
import { convertOfficeToPdf } from './converter.ts'
import { runOfficeWorker } from './worker-client.ts'

const OFFICE_INSPECT_TIMEOUT_MS = 30_000

export class ElectronOfficeProcessor implements OfficeProcessor {
  constructor(private readonly pdfProcessor: PdfProcessor) {}

  async inspect(
    path: string,
    options: OfficeInspectOptions,
    abortSignal: AbortSignal,
  ): Promise<OfficeInspection> {
    const result = await runOfficeWorker(
      { id: randomUUID(), operation: 'inspect', path, options },
      abortSignal,
      OFFICE_INSPECT_TIMEOUT_MS,
      384,
    )
    if (result.operation !== 'inspect') {
      throw new OfficeProcessingError('unknown', 'Office 检查返回了错误的操作结果')
    }
    return result.inspection
  }

  async renderPages(
    path: string,
    options: OfficeRenderOptions,
    abortSignal: AbortSignal,
  ): Promise<OfficeRenderResult> {
    validateRenderOptions(options)
    const inspection = await this.inspect(
      path,
      { startUnit: 1, unitCount: 1 },
      abortSignal,
    )
    const conversionDirectory = await mkdtemp(join(tmpdir(), 'whycode-office-pdf-'))
    try {
      const pdfPath = join(conversionDirectory, 'rendered.pdf')
      const renderer = await convertOfficeToPdf({
        sourcePath: path,
        format: inspection.format,
        pdfPath,
        workingDirectory: conversionDirectory,
        abortSignal,
      })
      const pdf = await this.pdfProcessor.inspect(pdfPath, abortSignal)
      if (options.startPage > pdf.pageCount) {
        throw new OfficeProcessingError(
          'invalid-range',
          `起始页 ${options.startPage} 超出总页数 ${pdf.pageCount}`,
        )
      }
      const result = await this.pdfProcessor.readPages(pdfPath, {
        mode: 'visual',
        startPage: options.startPage,
        pageCount: Math.min(options.pageCount, pdf.pageCount - options.startPage + 1),
        outputDirectory: options.outputDirectory,
      }, abortSignal)
      if (result.mode !== 'visual') {
        throw new OfficeProcessingError('unknown', 'Office PDF 渲染返回了非视觉结果')
      }
      return {
        format: inspection.format,
        pageCount: result.pageCount,
        renderer,
        renderedPages: result.renderedPages,
      }
    } finally {
      await rm(conversionDirectory, { recursive: true, force: true }).catch(() => {})
    }
  }
}

function validateRenderOptions(options: OfficeRenderOptions): void {
  if (!Number.isSafeInteger(options.startPage) || options.startPage < 1) {
    throw new OfficeProcessingError('invalid-range', 'Office 渲染起始页必须是正整数')
  }
  if (
    !Number.isSafeInteger(options.pageCount)
    || options.pageCount < 1
    || options.pageCount > OFFICE_RENDER_MAX_PAGES
  ) {
    throw new OfficeProcessingError(
      'invalid-range',
      `Office 每次最多渲染 ${OFFICE_RENDER_MAX_PAGES} 页`,
    )
  }
}
