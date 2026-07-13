import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import { runCommandTool, scanCommandPaths } from './index.ts'

const delay = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))

function failAfter(ms: number, message = 'RunCommand 未及时返回'): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
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
  // Windows PowerShell 5.1 会剥掉原生参数中的嵌套引号，测试脚本先编码再传递。
  const encoded = Buffer.from(script, 'utf8').toString('base64')
  const runner = 'eval(atob(process.argv[1]))'
  if (process.platform === 'win32') {
    const executable = process.execPath.replaceAll("'", "''")
    return `& '${executable}' -e '${runner}' '${encoded}'`
  }
  const executable = process.execPath.replaceAll("'", "'\\''")
  return `'${executable}' -e '${runner}' '${encoded}'`
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
  it('关闭 stdin，让等待输入结束的命令立即收到 EOF', async () => {
    const abortController = new AbortController()
    const execution = runCommandTool.execute(
      {
        command: nodeCommand(
          'process.stdin.resume(); process.stdin.on("end", () => console.log("stdin-closed"))',
        ),
        timeoutMs: 30_000,
      },
      {
        projectDir: process.cwd(),
        additionalDirs: [],
        abortSignal: abortController.signal,
      },
    )

    try {
      const result = await Promise.race([
        execution,
        failAfter(4_000, 'RunCommand 没有向等待输入的命令发送 EOF'),
      ])
      assert.equal(result.isError, false, result.data)
      assert.match(result.data, /stdin-closed/)
    } finally {
      abortController.abort('test-cleanup')
    }
  })

  it('Windows PowerShell 交互提示快速失败而不是等待命令超时', {
    skip: process.platform !== 'win32',
  }, async () => {
    const result = await Promise.race([
      runCommandTool.execute(
        { command: "Read-Host 'confirm'", timeoutMs: 30_000 },
        {
          projectDir: process.cwd(),
          additionalDirs: [],
          abortSignal: new AbortController().signal,
        },
      ),
      failAfter(8_000, 'PowerShell 交互提示没有快速失败'),
    ])

    assert.equal(result.isError, true)
    assert.match(result.data, /NonInteractive|ReadHostCommand/)
    assert.doesNotMatch(result.data, /命令超时/)
  })

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
    assert.match(failure.data, /\[退出码 2\]/)
    assert.doesNotMatch(failure.data, /命令成功/)

    if (process.platform === 'win32') {
      const cmdletFailure = await runCommandTool.execute(
        {
          command: `${nodeCommand('process.exit(0)')}; Get-Item -LiteralPath 'whycode-missing-command-result' -ErrorAction SilentlyContinue`,
        },
        context,
      )
      assert.equal(cmdletFailure.isError, true)
      assert.match(cmdletFailure.data, /\[退出码 1\]/)
    }
  })
})
