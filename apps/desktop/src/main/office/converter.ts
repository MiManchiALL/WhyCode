import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  access,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  OfficeProcessingError,
  officeExtension,
  type OfficeFormat,
  type OfficeRenderResult,
} from '@whycode/core/office'
import { runHiddenProcess } from './hidden-process.ts'
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
  const pidFile = join(options.workingDirectory, 'microsoft-office.pid')
  const scriptPath = join(options.workingDirectory, 'microsoft-office-render.vbs')
  await copyFile(options.sourcePath, stagedSource, constants.COPYFILE_EXCL)
  await writeFile(scriptPath, MICROSOFT_OFFICE_PDF_VBS, { encoding: 'ascii', mode: 0o600 })
  const cscript = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cscript.exe')
  let operationFailed = false
  try {
    await runHiddenProcess({
      command: cscript,
      args: ['//B', '//NoLogo', scriptPath, stagedSource, options.pdfPath, options.format, pidFile],
      workingDirectory: options.workingDirectory,
      abortSignal: options.abortSignal,
      timeoutMs: CONVERSION_TIMEOUT_MS,
      onForcedTermination: () => terminateRecordedOfficeProcess(pidFile, options.format),
    })
    await requirePdf(options.pdfPath)
  } catch (error) {
    operationFailed = true
    throw error
  } finally {
    let cleanupError: unknown
    try {
      await terminateRecordedOfficeProcess(pidFile, options.format)
    } catch (error) {
      cleanupError = error
    }
    await rm(pidFile, { force: true }).catch(() => {})
    if (cleanupError && !operationFailed) throw cleanupError
  }
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

async function findLibreOffice(): Promise<string | null> {
  for (const candidate of libreOfficeCandidates(process.env, process.platform)) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  return null
}

export function libreOfficeCandidates(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  const executableNames = platform === 'win32'
    ? ['soffice.exe', 'libreoffice.exe']
    : ['libreoffice', 'soffice']
  const fromPath = (environment.PATH ?? '').split(delimiter)
    .filter(Boolean)
    .flatMap((directory) => executableNames.map((name) => resolve(directory, name)))
  const common = platform === 'win32'
    ? [environment.ProgramFiles, environment['ProgramFiles(x86)']]
      .filter((value): value is string => Boolean(value))
      .map((directory) => join(directory, 'LibreOffice', 'program', 'soffice.exe'))
    : platform === 'darwin'
      ? ['/Applications/LibreOffice.app/Contents/MacOS/soffice']
      : ['/usr/bin/libreoffice', '/usr/bin/soffice', '/snap/bin/libreoffice']
  return [...new Set([...fromPath, ...common])]
}

async function terminateRecordedOfficeProcess(pidFile: string, format: OfficeFormat): Promise<void> {
  const value = await readFile(pidFile, 'ascii').catch(() => '')
  const pid = Number(value.trim())
  if (!Number.isSafeInteger(pid) || pid <= 0) return
  const expectedName = { docx: 'WINWORD.EXE', pptx: 'POWERPNT.EXE', xlsx: 'EXCEL.EXE' }[format]
  const powershell = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  )
  const script = [
    `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue`,
    'if(-not $p) { exit 0 }',
    `$cmd=[string]$p.CommandLine`,
    `if($p.Name -ne '${expectedName}' -or $cmd -notmatch '(?i)(/automation|-embedding)') { exit 2 }`,
    `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`,
    `for($i=0;$i -lt 30;$i++) { if(-not (Get-Process -Id ${pid} -ErrorAction SilentlyContinue)) { exit 0 }; Start-Sleep -Milliseconds 100 }`,
    'exit 3',
  ].join(';')
  const child = spawn(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
  ], { stdio: 'ignore', windowsHide: true })
  const outcome = await Promise.race([
    once(child, 'close').then(([code]) => ({ kind: 'close' as const, code })),
    once(child, 'error').then(([error]) => ({ kind: 'error' as const, error })),
    new Promise<{ kind: 'timeout' }>((resolveDelay) =>
      setTimeout(() => resolveDelay({ kind: 'timeout' }), 5_000)),
  ])
  if (outcome.kind === 'error') {
    throw new Error(`Office 后台进程清理启动失败：${outcome.error.message}`, {
      cause: outcome.error,
    })
  }
  if (outcome.kind === 'timeout') {
    child.kill()
    throw new Error('Office 后台进程清理超时')
  }
  if (outcome.code !== 0) {
    throw new Error(
      outcome.code === 2
        ? 'Office 后台进程身份校验失败，未执行终止'
        : 'Office 后台进程在转换完成后仍未退出',
    )
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
