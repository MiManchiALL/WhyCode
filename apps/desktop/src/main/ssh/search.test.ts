import assert from 'node:assert/strict'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { join } from 'node:path'
import { it } from 'node:test'
import type { ToolContext } from '@whycode/core'
import { globTool } from '../../../../../packages/core/src/tools/list-glob/index.ts'
import { grepTool } from '../../../../../packages/core/src/tools/grep/index.ts'
import { sshFixture } from './ssh-test-fixture.ts'

it('远端 Glob/Grep 原生搜索，不通过 SFTP 扫目录或下载文件，超时后连接仍能使用', {
  skip: process.env.WHYCODE_SSH_INTEGRATION !== '1', timeout: 90_000,
}, async t => {
  const env = await sshFixture(t, true)
  await env.connections.connect(env.id, env.fingerprint)
  const host = env.connections.host(env.id)
  const io = env.connections.io(host.target)
  const ctx: ToolContext = { workspaceIO: io, projectDir: env.project, additionalDirs: [], abortSignal: new AbortController().signal }
  await mkdir(join(env.root, 'project/nested'))
  await mkdir(join(env.root, 'project/node_modules'))
  await writeFile(join(env.root, 'project/target.png'), 'needle in image filename fixture')
  await writeFile(join(env.root, 'project/nested/target.png'), 'nested')
  await writeFile(join(env.root, 'project/nested/code.ts'), 'const needle = "中文"\n')
  await writeFile(join(env.root, 'project/node_modules/code.ts'), 'needle ignored')
  await writeFile(join(env.root, 'project/-options.txt'), 'needle single file\n')
  await writeFile(join(env.root, "project/quote'file.txt"), 'needle quoted file\n')
  const fs = { ...host.io.fs,
    readdir: async () => assert.fail('不应逐层读取 SFTP 目录'),
    readFile: async () => assert.fail('不应下载源文件进行搜索'),
  }
  const searchCtx = { ...ctx, workspaceIO: { ...io, fs } }
  const glob = await globTool.execute({ pattern: 'target.png' }, searchCtx)
  assert.match(glob.data, /nested\/target.png/)
  assert.match(glob.data, /(?:^|\n)target.png/)
  const grep = await grepTool.execute({ pattern: 'needle', include: '*.ts' }, searchCtx)
  assert.equal(grep.data, 'nested/code.ts:1:const needle = "中文"')
  for (const path of ['-options.txt', "quote'file.txt"]) {
    assert.match((await grepTool.execute({ pattern: 'needle', path }, searchCtx)).data, /:1:needle/)
  }
  const injection = await grepTool.execute({ pattern: '$(touch injected)', literal: true }, searchCtx)
  assert.equal(injection.data, '（无匹配）')
  await assert.rejects(access(join(env.root, 'project/injected')), { code: 'ENOENT' })
  await assert.rejects(grepTool.execute({ pattern: '[' }, searchCtx), /ripgrep 执行失败/)
  const first = await globTool.execute({ pattern: '*.txt', limit: 1 }, searchCtx)
  assert.match(first.data, /offset=1/)
  const next = await globTool.execute({ pattern: '*.txt', limit: 1, offset: 1 }, searchCtx)
  assert.notEqual(first.data.split('\n')[0], next.data.split('\n')[0])

  const child = host.processes.spawn({ executable: '/bin/sh', args: ['-c', 'exec sleep 60'] }, env.project)
  const closed = once(child, 'close')
  await once(child, 'spawn')
  const result = await globTool.execute({ pattern: '*' }, { ...searchCtx, workspaceIO: { ...searchCtx.workspaceIO, ripgrep: () => child } })
  assert.equal(result.isError, true)
  assert.match(result.data, /搜索超时（30 秒）/)
  await closed
  assert.equal(env.connections.isConnected(env.id), true)
  assert.equal((await grepTool.execute({ pattern: 'needle', include: '*.ts' }, searchCtx)).isError, false)
  await env.connections.cleanup(env.id)
  await assert.rejects(access(join(env.root, '.cache/whycode-remote')), { code: 'ENOENT' })
  assert.throws(() => io.fs.realpath(env.project), /SSH 未连接/)
})
