import assert from 'node:assert/strict'
import { access, mkdir, utimes, writeFile } from 'node:fs/promises'
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
  for (const directory of ['.git', 'node_modules', 'nested/node_modules', 'nested/.cache', 'build']) {
    await mkdir(join(env.root, 'project', directory))
    await writeFile(join(env.root, 'project', directory, 'code.ts'), 'needle in ' + directory)
    await writeFile(join(env.root, 'project', directory, 'target.png'), 'image fixture')
  }
  await writeFile(join(env.root, 'project/target.png'), 'needle in image filename fixture')
  await writeFile(join(env.root, 'project/nested/target.png'), 'nested')
  for (const [index, path] of ['target.png', 'build/target.png', 'nested/target.png'].entries()) {
    await utimes(join(env.root, 'project', path), 1_700_000_000, 1_700_000_000 + index)
  }
  await writeFile(join(env.root, 'project/nested/code.ts'), 'const needle = "中文"\n')
  await writeFile(join(env.root, 'project/.gitignore'), 'ignored.ts\n.cache/\n')
  await writeFile(join(env.root, 'project/ignored.ts'), 'needle ignored by project\n')
  await writeFile(join(env.root, 'project/-options.txt'), 'needle single file\n')
  await writeFile(join(env.root, "project/quote'file.txt"), 'needle quoted file\n')
  const fs = { ...host.io.fs,
    readdir: async () => assert.fail('不应逐层读取 SFTP 目录'),
    lstat: async () => assert.fail('不应逐个查询远端文件的修改时间'),
    readFile: async () => assert.fail('不应下载源文件进行搜索'),
  }
  const searchCtx = { ...ctx, workspaceIO: { ...io, fs } }
  const glob = await globTool.execute({ pattern: 'target.png' }, searchCtx)
  assert.equal(glob.data, 'nested/target.png\nbuild/target.png\ntarget.png')
  const grep = await grepTool.execute({ pattern: 'needle', include: '*.ts' }, searchCtx)
  assert.equal(grep.data, 'build/code.ts:1:needle in build\nnested/code.ts:1:const needle = "中文"')
  assert.equal((await globTool.execute({ pattern: 'ignored.ts' }, searchCtx)).data, '（无匹配文件）')
  assert.equal((await globTool.execute({ pattern: 'ignored.ts', gitignore: false }, searchCtx)).data, 'ignored.ts')
  const files = await grepTool.execute({ pattern: 'needle', include: '*.ts', gitignore: false, outputMode: 'files_with_matches' }, searchCtx)
  assert.deepEqual(files.data.split('\n'), ['build/code.ts', 'ignored.ts', 'nested/.cache/code.ts', 'nested/code.ts'])
  for (const path of ['-options.txt', "quote'file.txt"]) {
    assert.match((await grepTool.execute({ pattern: 'needle', path }, searchCtx)).data, /:1:needle/)
  }
  const injection = await grepTool.execute({ pattern: '$(touch injected)' }, searchCtx)
  assert.equal(injection.data, '（无匹配）')
  await assert.rejects(access(join(env.root, 'project/injected')), { code: 'ENOENT' })
  await assert.rejects(grepTool.execute({ pattern: '[' }, searchCtx), /unclosed character class/)
  for (const tool of [grepTool, globTool]) {
    await assert.rejects(tool.execute({ pattern: 'needle', path: 'missing/subdir' }, searchCtx),
      { message: '搜索路径不存在' })
  }
  const pages = join(env.root, 'project/pages')
  await mkdir(pages)
  for (let n = 0; n <= 200; n++) {
    const path = join(pages, String(n).padStart(3, '0') + '.txt')
    await writeFile(path, '')
    await utimes(path, 1_700_000_000, 1_700_000_000 + n)
  }
  const first = await globTool.execute({ path: 'pages', pattern: '*.txt' }, searchCtx)
  assert.match(first.data, /^# pages\/\n200\.txt\n199\.txt\n/)
  assert.match(first.data, /\[用 offset=200 继续\]$/)
  const next = await globTool.execute({ path: 'pages', pattern: '*.txt', offset: 200 }, searchCtx)
  assert.equal(next.data, 'pages/000.txt')

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
