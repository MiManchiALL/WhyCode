import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'

const TERMINATION_GRACE_MS = 500
const TASKKILL_TIMEOUT_MS = 3_000

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

async function terminateWindowsTree(child: ChildProcess, pid: number): Promise<boolean> {
  const killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  const completed = await Promise.race([
    once(killer, 'close').then(([code]) => code === 0),
    once(killer, 'error').then(() => false),
    delay(TASKKILL_TIMEOUT_MS).then(() => {
      killer.kill()
      return false
    }),
  ])
  if (!completed && !hasExited(child)) child.kill()
  return completed
}

async function terminatePosixTree(child: ChildProcess, pid: number): Promise<boolean> {
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    if (!child.kill('SIGTERM')) return hasExited(child)
  }

  await Promise.race([once(child, 'exit').then(() => undefined), delay(TERMINATION_GRACE_MS)])
  if (hasExited(child)) return true
  try {
    process.kill(-pid, 'SIGKILL')
    return true
  } catch {
    return child.kill('SIGKILL') || hasExited(child)
  }
}

/** 终止命令的完整进程树；Windows 必须先杀树，不能先让 shell 退出而留下孤儿进程。 */
export async function terminateProcessTree(child: ChildProcess): Promise<boolean> {
  const pid = child.pid
  if (!pid) {
    child.kill()
    return false
  }
  return process.platform === 'win32'
    ? terminateWindowsTree(child, pid)
    : terminatePosixTree(child, pid)
}
