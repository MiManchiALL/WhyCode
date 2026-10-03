import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { runCommandTool } from './run-command/index.ts'
import { CommandSessionManager } from './background-command/manager.ts'

const context = () => ({ projectDir: process.cwd(), additionalDirs: [], abortSignal: new AbortController().signal })
const assertText = (output: string) => assert.doesNotMatch(output, /CLIXML|<Objs|_x000D_|\uFFFD/)

describe('PowerShell 命令输出', { skip: process.platform !== 'win32' }, () => {
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
      let offset = 0
      let output = ''
      const deadline = Date.now() + 10000
      while (Date.now() < deadline) {
        const chunk = await manager.readOutput(started.sessionId, started.id, offset, 32768, 500)
        output += chunk.output
        offset = chunk.nextOffset
        if (chunk.task.status === 'running') continue
        assert.equal(chunk.task.status, 'failed')
        assert.equal(chunk.task.exitCode, 7)
        assert.match(output, /后台中文/)
        assert.match(output, /后台失败/)
        assertText(output)
        return
      }
      assert.fail('后台命令未在测试时限内结束')
    } finally {
      await manager.shutdown()
      assert.ok(root.startsWith(join(tmpdir(), 'whycode-powershell-test-')))
      await rm(root, { recursive: true, force: true })
    }
  })
})
