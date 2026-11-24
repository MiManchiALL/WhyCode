import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { it } from 'node:test'
import { createReadFileTool } from '@whycode/core'
import { sshFixture } from './ssh-test-fixture.ts'

it('SSH 与本机文本分页相同，包括实际末行、不同换行、超长行续读和无效 UTF-8', {
  skip: process.env.WHYCODE_SSH_INTEGRATION !== '1', timeout: 90_000,
}, async t => {
  const env = await sshFixture(t, true)
  await env.connections.connect(env.id, env.fingerprint)
  const io = env.connections.io(env.connections.host(env.id).target)
  const projectDir = join(env.root, 'project')
  await mkdir(join(projectDir, 'folder'))
  await writeFile(join(projectDir, 'empty'), '')
  await writeFile(join(projectDir, 'binary'), Buffer.from([97, 0, 98]))
  const units = '甲🌟é'.repeat(36000)
  await writeFile(join(projectDir, 'lines'), Buffer.concat([Buffer.from('one\r\n二\r\n\r' + units + '\r\n'),
    Buffer.from([0xe2, 0x82, 0x41, 0xff]), Buffer.from('\n结尾')]))
  const tool = createReadFileTool()
  const context = { projectDir, additionalDirs: [], abortSignal: new AbortController().signal }
  async function compare(input: { path: string; offset?: number; column?: number; limit?: number }) {
    const local = await tool.execute(input, context)
    const remote = await tool.execute(input, { ...context, workspaceIO: io, projectDir: env.project })
    assert.deepEqual(remote, local)
    return remote.data
  }
  for (const path of ['folder', 'empty', 'binary']) await compare({ path })
  for (const path of ['missing', 'missing/subdir/file.txt']) {
    await assert.rejects(tool.execute({ path }, { ...context, workspaceIO: io, projectDir: env.project }),
      { message: '文件不存在' })
  }
  for (const [offset, column, limit] of [[1, 1, 3], [3, 2, 1], [4, 107998, 2], [5, 2, 1], [5, 4, 1],
    [6, 1, 1], [7, 1, 1]] as const) {
    await compare({ path: 'lines', offset, column, limit })
  }
  const first = await compare({ path: 'lines', offset: 4, limit: 1 })
  const nextColumn = Number(/column=(\d+)/u.exec(first)?.[1])
  assert.ok(nextColumn > 1)
  await compare({ path: 'lines', offset: 4, column: nextColumn, limit: 1 })
  // CR 占据缓冲区最后一个字节，LF 在下一次填充。
  await writeFile(join(projectDir, 'crlf'), 'x'.repeat(65535) + '\r\nend\n')
  assert.match(await compare({ path: 'crlf', offset: 2, limit: 1 }), /end$/u)
})
