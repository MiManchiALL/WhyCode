import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import { runCommandTool, scanCommandPaths } from './index.ts'

const delay = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))

function failAfter(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('RunCommand 未在中止后及时返回')), ms)
    timer.unref()
  })
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function forceKill(pid: number): Promise<void> {
  if (!isProcessRunning(pid)) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    await once(killer, 'close')
    return
  }
  process.kill(pid, 'SIGKILL')
}

function nodeCommand(script: string): string {
  if (process.platform === 'win32') {
    const executable = process.execPath.replaceAll("'", "''")
    return `& '${executable}' -e '${script}'`
  }
  const executable = process.execPath.replaceAll("'", "'\\''")
  return `'${executable}' -e '${script}'`
}

function descendantCommand(): string {
  return nodeCommand('console.log(process.pid); setInterval(() => {}, 1000)')
}

describe('RunCommand 路径扫描', () => {
  it('识别 PowerShell 环境变量展开后的项目外路径', () => {
    const name = 'WHYCODE_TEST_HOME'
    const previous = process.env[name]
    process.env[name] = 'C:\\Users\\WhyCode Test'
    try {
      const paths = scanCommandPaths(
        'Set-Content -Path "$env:WHYCODE_TEST_HOME\\Desktop\\hello.txt" -Value hello',
      )

      assert.deepEqual(paths, [resolve('C:\\Users\\WhyCode Test\\Desktop\\hello.txt')])
    } finally {
      if (previous === undefined) delete process.env[name]
      else process.env[name] = previous
    }
  })
})

describe('RunCommand 中止', () => {
  it('停止时终止命令进程树并及时返回', async () => {
    const abortController = new AbortController()
    let progress = ''
    let descendantPid: number | null = null
    let abortScheduled = false

    const execution = runCommandTool.execute(
      { command: descendantCommand(), timeoutMs: 30_000 },
      {
        projectDir: process.cwd(),
        additionalDirs: [],
        abortSignal: abortController.signal,
        onProgress(output) {
          progress += output
          const match = progress.match(/\b(\d+)\b/)
          if (!match || abortScheduled) return
          descendantPid = Number(match[1])
          abortScheduled = true
          setTimeout(() => abortController.abort('user-cancel'), 50)
        },
      },
    )

    try {
      const result = await Promise.race([
        execution,
        failAfter(4_000),
      ])

      assert.equal(result.isError, true)
      assert.match(result.data, /中断/)
      assert.ok(descendantPid, '命令应输出后代进程 PID')
      await delay(100)
      assert.equal(isProcessRunning(descendantPid), false, '中止后不应残留后代进程')
    } finally {
      abortController.abort('test-cleanup')
      if (descendantPid) await forceKill(descendantPid)
    }
  })
})

describe('RunCommand 结果', () => {
  it('没有 stdout 时明确区分命令成功和失败', async () => {
    const context = {
      projectDir: process.cwd(),
      additionalDirs: [],
      abortSignal: new AbortController().signal,
    }
    const success = await runCommandTool.execute(
      { command: nodeCommand('void 0') },
      context,
    )
    const failure = await runCommandTool.execute(
      { command: nodeCommand('process.exit(2)') },
      context,
    )

    assert.equal(success.isError, false)
    assert.equal(success.data, '（命令成功，无标准输出）')
    assert.equal(failure.isError, true)
    assert.match(failure.data, /\[退出码 [1-9]\d*\]/)
    assert.doesNotMatch(failure.data, /命令成功/)
  })
})
