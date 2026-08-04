import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { OfficeFormat } from '@whycode/core/office'
import { runHiddenProcess } from './hidden-process.ts'

export async function runMicrosoftOfficeVbs(options: {
  script: string
  scriptName: string
  arguments: readonly string[]
  format: OfficeFormat
  workingDirectory: string
  abortSignal: AbortSignal
  timeoutMs: number
}): Promise<void> {
  const pidFile = join(options.workingDirectory, `${options.scriptName}.pid`)
  const scriptPath = join(options.workingDirectory, `${options.scriptName}.vbs`)
  await writeFile(scriptPath, options.script, { encoding: 'ascii', mode: 0o600 })
  const cscript = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cscript.exe')
  let operationFailed = false
  try {
    await runHiddenProcess({
      command: cscript,
      args: ['//B', '//NoLogo', scriptPath, ...options.arguments, pidFile],
      workingDirectory: options.workingDirectory,
      abortSignal: options.abortSignal,
      timeoutMs: options.timeoutMs,
      onForcedTermination: () => terminateRecordedOfficeProcess(pidFile, options.format),
    })
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

async function terminateRecordedOfficeProcess(
  pidFile: string,
  format: OfficeFormat,
): Promise<void> {
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
    throw new Error(`Office 后台进程清理启动失败：${outcome.error.message}`, { cause: outcome.error })
  }
  if (outcome.kind === 'timeout') {
    child.kill()
    throw new Error('Office 后台进程清理超时')
  }
  if (outcome.code !== 0) {
    // PID may already have been recycled after Office quit normally. Identity
    // mismatch is a safe no-op: never terminate a process we cannot prove is ours.
    if (outcome.code === 2) return
    throw new Error('Office 后台进程在操作完成后仍未退出')
  }
}
