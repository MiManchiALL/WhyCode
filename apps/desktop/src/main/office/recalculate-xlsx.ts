import { constants } from 'node:fs'
import {
  copyFile,
  mkdir,
  open,
  rename,
  rm,
} from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { OfficeProcessingError } from '@whycode/core/office'
import { runHiddenProcess } from './hidden-process.ts'
import { findLibreOffice } from './libreoffice.ts'
import { runMicrosoftOfficeVbs } from './microsoft-office-automation.ts'
import { MICROSOFT_EXCEL_RECALCULATE_VBS } from './microsoft-office-vbs.ts'

const RECALCULATION_TIMEOUT_MS = 120_000
const ZIP_SIGNATURES = [0x04034b50, 0x06054b50]

export async function recalculateXlsx(options: {
  sourcePath: string
  outputPath: string
  workingDirectory: string
  abortSignal: AbortSignal
}): Promise<'microsoft-excel' | 'libreoffice'> {
  const errors: string[] = []
  let timedOut = false
  await rm(options.outputPath, { force: true })
  if (process.platform === 'win32') {
    try {
      await recalculateWithMicrosoftExcel(options)
      return 'microsoft-excel'
    } catch (error) {
      if (isAbort(error)) throw error
      if (isTimeout(error)) timedOut = true
      errors.push(`Microsoft Excel：${errorMessage(error)}`)
    }
  }
  const libreOffice = await findLibreOffice()
  if (libreOffice) {
    try {
      await rm(options.outputPath, { force: true })
      await recalculateWithLibreOffice(libreOffice, options)
      return 'libreoffice'
    } catch (error) {
      if (isAbort(error)) throw error
      if (isTimeout(error)) timedOut = true
      errors.push(`LibreOffice：${errorMessage(error)}`)
    }
  }
  const detail = errors.length > 0 ? `（${errors.join('；')}）` : ''
  if (timedOut) throw new OfficeProcessingError('timeout', `XLSX 公式重算超时${detail}`)
  throw new OfficeProcessingError('renderer-unavailable', `没有可用的 XLSX 公式重算引擎${detail}`)
}

async function recalculateWithMicrosoftExcel(
  options: Parameters<typeof recalculateXlsx>[0],
): Promise<void> {
  await runMicrosoftOfficeVbs({
    script: MICROSOFT_EXCEL_RECALCULATE_VBS,
    scriptName: 'microsoft-excel-recalculate',
    arguments: [options.sourcePath, options.outputPath],
    format: 'xlsx',
    workingDirectory: options.workingDirectory,
    abortSignal: options.abortSignal,
    timeoutMs: RECALCULATION_TIMEOUT_MS,
  })
  await requireXlsx(options.outputPath)
}

async function recalculateWithLibreOffice(
  executable: string,
  options: Parameters<typeof recalculateXlsx>[0],
): Promise<void> {
  const inputDirectory = join(options.workingDirectory, 'recalculate-input')
  const outputDirectory = join(options.workingDirectory, 'recalculate-output')
  const profileDirectory = join(options.workingDirectory, 'recalculate-profile')
  await Promise.all([
    mkdir(inputDirectory, { recursive: true }),
    mkdir(outputDirectory, { recursive: true }),
    mkdir(profileDirectory, { recursive: true }),
  ])
  const stagedSource = join(inputDirectory, 'source.xlsx')
  await copyFile(options.sourcePath, stagedSource, constants.COPYFILE_EXCL)
  await runHiddenProcess({
    command: executable,
    args: [
      '--headless', '--invisible', '--nologo', '--nodefault', '--nolockcheck', '--norestore',
      `-env:UserInstallation=${pathToFileURL(profileDirectory).href}`,
      '--convert-to', 'xlsx:Calc MS Excel 2007 XML', '--outdir', outputDirectory, stagedSource,
    ],
    workingDirectory: options.workingDirectory,
    abortSignal: options.abortSignal,
    timeoutMs: RECALCULATION_TIMEOUT_MS,
  })
  await rename(join(outputDirectory, 'source.xlsx'), options.outputPath)
  await requireXlsx(options.outputPath)
}

async function requireXlsx(path: string): Promise<void> {
  const file = await open(path, 'r').catch((error) => {
    throw new Error('公式重算没有生成 XLSX', { cause: error })
  })
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size < 4) throw new Error('公式重算生成了空 XLSX')
    const header = Buffer.alloc(4)
    const { bytesRead } = await file.read(header, 0, 4, 0)
    if (bytesRead !== 4 || !ZIP_SIGNATURES.includes(header.readUInt32LE(0))) {
      throw new Error('公式重算结果不是有效 OOXML ZIP')
    }
  } finally {
    await file.close()
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof OfficeProcessingError && error.code === 'aborted'
}

function isTimeout(error: unknown): boolean {
  return error instanceof OfficeProcessingError && error.code === 'timeout'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
