import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { sshFixture } from '../ssh/ssh-test-fixture.ts'
import { WorkspaceDependencies } from './index.ts'
import { waitDependencyProcess } from './process.ts'

test('Linux SSH prepares, reuses and removes Office dependencies while preserving project and Skill files', {
  skip: process.env.WHYCODE_OFFICE_INTEGRATION !== '1', timeout: 15 * 60 * 1000,
}, async t => {
  const env = await sshFixture(t, true)
  await env.connections.connect(env.id, env.fingerprint)
  const host = env.connections.host(env.id)
  const dependencies = new WorkspaceDependencies(resolve('resources/office'), resolve('../../.cache/office-verification'), env.connections)
  const messages: string[] = []
  const context = { projectDir: env.project, additionalDirs: [], workspaceIO: host.io,
    abortSignal: new AbortController().signal, onProgress: (message: string) => { messages.push(message); console.log(message) } }
  const paths = await dependencies.load(context)
  assert.ok(paths.node.startsWith(host.home + '/.cache/whycode-remote/office/'))
  const first = messages.length
  assert.deepEqual(await dependencies.load(context), paths)
  assert.equal(messages.length, first)
  const testFile = env.project + '/office.test.mjs'
  await host.io.fs.writeFile(testFile, await readFile(resolve('../../workspace-runtime/office/office.test.mjs')))
  const output = await waitDependencyProcess(host.processes.spawn({
    executable: paths.node, args: [paths.run, testFile, host.io.path.dirname(paths.office)],
  }, env.project), context.abortSignal)
  console.log(output)
  assert.match(output, /pass 6/)
  const native = host.home + '/.whycode/skills/native'
  await host.io.fs.mkdir(native, { recursive: true })
  await host.io.fs.writeFile(native + '/SKILL.md', 'native')
  await host.io.fs.mkdir(host.home + '/.cache/whycode-scratch/session', { recursive: true })
  env.connections.disconnect(env.id)
  await env.connections.cleanup(env.id)
  await assert.rejects(access(join(env.root, '.cache/whycode-remote')), { code: 'ENOENT' })
  await access(join(env.root, '.whycode/skills/native/SKILL.md'))
  await access(join(env.root, '.cache/whycode-scratch/session'))
  await access(join(env.root, 'project/office.test.mjs'))
})
