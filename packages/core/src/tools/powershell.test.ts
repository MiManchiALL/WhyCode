import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { runCommandTool } from './run-command/index.ts'
import { CommandSessionManager } from './background-command/manager.ts'
import type { CommandTaskSnapshot } from './background-command/types.ts'

const context = () => ({ projectDir: process.cwd(), additionalDirs: [], abortSignal: new AbortController().signal })
const assertText = (output: string) => assert.doesNotMatch(output, /CLIXML|<Objs|_x000D_|\uFFFD/)

describe('PowerShell 命令输出', { skip: process.platform !== 'win32' }, () => {
  it('前台对象、目录和进程查询在结束前输出完整表格', async () => {
    const commands = [
      { command: "[pscustomobject]@{Name='对象结果';Count=42}", expected: /对象结果\s+42/ },
      { command: 'Get-ChildItem -LiteralPath . -Filter package.json | Select-Object Name', expected: /package\.json/ },
      { command: 'Get-Process | Where-Object { $_.Id -eq $PID } | Select-Object Id,ProcessName', expected: /\d+\s+powershell/ },
    ]
    for (const { command, expected } of commands) {
      let progress = ''
      const result = await runCommandTool.execute({ command }, {
        ...context(),
        onProgress(output) { progress += output },
      })
      assert.equal(result.isError, false, result.data)
      assert.match(result.data, expected)
      assert.equal(progress, result.data, '实时输出与最终结果都必须包含对象内容')
      assertText(result.data)
    }
  })

  it('格式化对象后仍保留 cmdlet 和原生退出码，return 正常结束', async () => {
    for (const [ending, exitCode] of [
      ["Write-Error '对象后的错误'", 1],
      ['cmd /c exit 7', 7],
      ["cmd /c exit 0; Get-Item -LiteralPath 'whycode-missing-command-result' -ErrorAction SilentlyContinue", 1],
      ['return', 0],
    ] as const) {
      const result = await runCommandTool.execute({
        command: `[pscustomobject]@{Name='保留对象';Count=42}; ${ending}`,
      }, context())
      assert.equal(result.isError, exitCode !== 0, result.data)
      assert.match(result.data, /保留对象\s+42/)
      if (exitCode !== 0) assert.ok(result.data.endsWith(`[退出码 ${exitCode}]`), result.data)
      assertText(result.data)
    }
  })

  it('按 UTF-8 返回中文、引号、换行和标准错误，不输出序列化标记', async () => {
    const result = await runCommandTool.execute({ command: [
      "$value = '中文 路径 😀 ''单引号'' \"双引号\" $()'",
      'Write-Output $value',
      "[Console]::Error.WriteLine('错误说明')",
      "Write-Progress -Activity '检查' -Status '进行中'",
    ].join('\n') }, context())
    assert.equal(result.isError, false, result.data)
    assert.match(result.data, /中文 路径 😀 '单引号' "双引号" \$\(\)/)
    assert.match(result.data, /错误说明/)
    assertText(result.data)
  })

  it('语法错误、cmdlet 错误和终止错误保留可读中文与失败状态', async () => {
    for (const command of ["Write-Output ) '语法错误'", "Write-Error '中文失败'", "throw '中文失败'"]) {
      const result = await runCommandTool.execute({ command }, context())
      assert.equal(result.isError, true, result.data)
      assert.match(result.data, /语法错误|中文失败/)
      assert.match(result.data, /\[退出码 1\]/)
      assertText(result.data)
    }
  })

  it('中文 PowerShell 管道输入能被原生程序按 UTF-8 读取', async () => {
    const script = Buffer.from("process.stdout.write(require('node:fs').readFileSync(0))").toString('base64')
    const result = await runCommandTool.execute({
      command: `'中文输入' | & '${process.execPath.replaceAll("'", "''")}' -e 'eval(atob(process.argv[1]))' ${script}`,
    }, context())
    assert.equal(result.isError, false, result.data)
    assert.match(result.data, /中文输入/)
    assertText(result.data)
  })

  it('后台命令共用文本编码并保留原生退出码', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-powershell-test-'))
    const manager = new CommandSessionManager(root)
    try {
      const started = await manager.start({
        sessionId: '11111111-1111-4111-8111-111111111111',
        cwd: process.cwd(),
        command: "Write-Output '后台中文'; Write-Error '后台失败'; cmd /c exit 7",
      })
      const { task, output } = await readToCompletion(manager, started)
      assert.equal(task.status, 'failed')
      assert.equal(task.exitCode, 7)
      assert.match(output, /后台中文/)
      assert.match(output, /后台失败/)
      assertText(output)
    } finally {
      await manager.shutdown()
      assert.ok(root.startsWith(join(tmpdir(), 'whycode-powershell-test-')))
      await rm(root, { recursive: true, force: true })
    }
  })

  it('后台命令在发布终态前保存对象表格，重新打开后仍可读取', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-powershell-test-'))
    const manager = new CommandSessionManager(root)
    const reopened = new CommandSessionManager(root)
    try {
      const started = await manager.start({
        sessionId: '11111111-1111-4111-8111-111111111111',
        cwd: process.cwd(),
        command: "[pscustomobject]@{Name='后台对象';Count=42}",
      })
      const { task, output } = await readToCompletion(manager, started)
      assert.equal(task.status, 'completed')
      assert.equal(task.exitCode, 0)
      assert.match(output, /后台对象\s+42/)
      assertText(output)
      await manager.shutdown()
      await reopened.initialize()
      const replay = await reopened.readOutput(started.sessionId, started.id)
      assert.equal(replay.output, output)
      assert.equal(replay.task.status, 'completed')
    } finally {
      await reopened.shutdown()
      await manager.shutdown()
      assert.ok(root.startsWith(join(tmpdir(), 'whycode-powershell-test-')))
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function readToCompletion(manager: CommandSessionManager, started: CommandTaskSnapshot) {
  let offset = 0
  let output = ''
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const chunk = await manager.readOutput(started.sessionId, started.id, offset, 32768, 500)
    output += chunk.output
    offset = chunk.nextOffset
    if (chunk.task.status !== 'running') return { task: chunk.task, output }
  }
  assert.fail('后台命令未在测试时限内结束')
}
