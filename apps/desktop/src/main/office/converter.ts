import {
  copyFile,
  mkdir,
  open,
  rename,
  rm,
} from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  OfficeProcessingError,
  officeExtension,
  type OfficeFormat,
  type OfficeRenderResult,
} from '@whycode/core/office'
import { runHiddenProcess } from './hidden-process.ts'
import { findLibreOffice } from './libreoffice.ts'
import { runMicrosoftOfficeVbs } from './microsoft-office-automation.ts'
import { MICROSOFT_OFFICE_PDF_VBS } from './microsoft-office-vbs.ts'

const CONVERSION_TIMEOUT_MS = 120_000
const PDF_SIGNATURE = Buffer.from('%PDF-')

export async function convertOfficeToPdf(options: {
  sourcePath: string
  format: OfficeFormat
  pdfPath: string
  workingDirectory: string
  abortSignal: AbortSignal
}): Promise<OfficeRenderResult['renderer']> {
  const errors: string[] = []
  let timedOut = false
  await rm(options.pdfPath, { force: true })
  const libreOffice = await findLibreOffice()
  if (libreOffice) {
    try {
      await convertWithLibreOffice(libreOffice, options)
      return 'libreoffice'
    } catch (error) {
      if (error instanceof OfficeProcessingError && error.code === 'aborted') throw error
      if (error instanceof OfficeProcessingError && error.code === 'timeout') timedOut = true
      errors.push(`LibreOffice：${errorMessage(error)}`)
    }
  }
  if (process.platform === 'win32') {
    try {
      await rm(options.pdfPath, { force: true })
      await convertWithMicrosoftOffice(options)
      return 'microsoft-office'
    } catch (error) {
      if (error instanceof OfficeProcessingError && error.code === 'aborted') throw error
      if (error instanceof OfficeProcessingError && error.code === 'timeout') timedOut = true
      errors.push(`Microsoft Office：${errorMessage(error)}`)
    }
  }
  const detail = errors.length > 0 ? `（${errors.join('；')}）` : ''
  if (timedOut) {
    throw new OfficeProcessingError('timeout', `Office 后台渲染超时${detail}`)
  }
  throw new OfficeProcessingError(
    'renderer-unavailable',
    `没有可用的 Office 后台渲染器${detail}`,
  )
}

async function convertWithLibreOffice(
  executable: string,
  options: Parameters<typeof convertOfficeToPdf>[0],
): Promise<void> {
  const inputDirectory = join(options.workingDirectory, 'libreoffice-input')
  const outputDirectory = join(options.workingDirectory, 'libreoffice-output')
  const profileDirectory = join(options.workingDirectory, 'libreoffice-profile')
  await Promise.all([
    mkdir(inputDirectory, { recursive: true }),
    mkdir(outputDirectory, { recursive: true }),
    mkdir(profileDirectory, { recursive: true }),
  ])
  const stagedSource = join(inputDirectory, `source${officeExtension(options.format)}`)
  await copyFile(options.sourcePath, stagedSource, constants.COPYFILE_EXCL)
  await runHiddenProcess({
    command: executable,
    args: [
      '--headless', '--invisible', '--nologo', '--nodefault', '--nolockcheck', '--norestore',
      `-env:UserInstallation=${pathToFileURL(profileDirectory).href}`,
      '--convert-to', 'pdf', '--outdir', outputDirectory, stagedSource,
    ],
    workingDirectory: options.workingDirectory,
    abortSignal: options.abortSignal,
    timeoutMs: CONVERSION_TIMEOUT_MS,
  })
  await rename(join(outputDirectory, 'source.pdf'), options.pdfPath)
  await requirePdf(options.pdfPath)
}

async function convertWithMicrosoftOffice(
  options: Parameters<typeof convertOfficeToPdf>[0],
): Promise<void> {
  const stagedSource = join(options.workingDirectory, `microsoft-source${officeExtension(options.format)}`)
  await copyFile(options.sourcePath, stagedSource, constants.COPYFILE_EXCL)
  await runMicrosoftOfficeVbs({
    script: MICROSOFT_OFFICE_PDF_VBS,
    scriptName: 'microsoft-office-render',
    arguments: [stagedSource, options.pdfPath, options.format],
    format: options.format,
    workingDirectory: options.workingDirectory,
    abortSignal: options.abortSignal,
    timeoutMs: CONVERSION_TIMEOUT_MS,
  })
  await requirePdf(options.pdfPath)
}

async function requirePdf(path: string): Promise<void> {
  const file = await open(path, 'r').catch((error) => {
    throw new Error('后台转换没有生成 PDF', { cause: error })
  })
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size < PDF_SIGNATURE.length) throw new Error('后台转换生成了空 PDF')
    const header = Buffer.alloc(PDF_SIGNATURE.length)
    const { bytesRead } = await file.read(header, 0, header.length, 0)
    if (bytesRead !== header.length || !header.equals(PDF_SIGNATURE)) {
      throw new Error('后台转换结果不是有效 PDF')
    }
  } finally {
    await file.close()
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
