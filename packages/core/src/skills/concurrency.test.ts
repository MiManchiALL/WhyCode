import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, type TestContext } from 'node:test'
import { localWorkspaceIO, type WorkspaceIO } from '../workspace/io.ts'
import { SkillCatalogService } from './catalog.ts'
import { discoverSkillFiles } from './discovery.ts'

it('目录扫描并行处理同层目录，保留 BFS 顺序与嵌套 Skill', { timeout: 5_000 }, async t => {
  const { root, skillRoot, paths } = await fixture(t)
  const nested = join(skillRoot, 'skill-00', 'nested')
  await mkdir(nested)
  await writeFile(join(nested, 'SKILL.md'), document('nested'))
  const gates = firstBatchGates(t)
  const io: WorkspaceIO = {
    ...localWorkspaceIO,
    fs: {
      ...localWorkspaceIO.fs,
      readdir: async (path, options) => {
        if (paths.some(file => file === join(path, 'SKILL.md'))) await gates.enter()
        return localWorkspaceIO.fs.readdir(path, options)
      },
    },
  }
  const diagnostics: { path: string; message: string }[] = []
  const pending = discoverSkillFiles(skillRoot, diagnostics, undefined, io)
  await gates.ready
  const firstBatchSize = gates.started()
  gates.release()
  const files = await pending
  assert.equal(firstBatchSize, 8)
  assert.deepEqual(files, [...paths, join(nested, 'SKILL.md')])
  assert.deepEqual(diagnostics, [])
  assert.equal(gates.peak(), 8)
  assert.ok(files.every(path => path.startsWith(root)))
})

it('正文预读有并发上限，按发现顺序截断且等待本批文件关闭', { timeout: 5_000 }, async t => {
  const { root, project, paths } = await fixture(t)
  const gates = firstBatchGates(t)
  let openFiles = 0
  let peakOpenFiles = 0
  const io: WorkspaceIO = {
    ...localWorkspaceIO, identity: 'remote-fixture',
    fs: {
      ...localWorkspaceIO.fs,
      open: async (path, flags) => {
        await gates.enter()
        const file = await localWorkspaceIO.fs.open(path, flags)
        peakOpenFiles = Math.max(peakOpenFiles, ++openFiles)
        return {
          stat: () => file.stat(),
          read: (...args) => file.read(...args),
          close: async () => { await file.close(); openFiles-- },
        }
      },
    },
  }
  const catalog = new SkillCatalogService({
    workspaceIO: io, maxSnapshotBytes: Buffer.byteLength(document('skill-00')) + 1,
  })
  const pending = catalog.snapshot(project)
  await gates.ready
  const firstBatchSize = gates.started()
  gates.release()
  const snapshot = await pending
  assert.equal(firstBatchSize, 8)
  assert.deepEqual(snapshot.entries.map(skill => skill.path), [paths[0]])
  assert.deepEqual(snapshot.diagnostics.map(diagnostic => diagnostic.path), [paths[1]])
  assert.match(snapshot.diagnostics[0]!.message, /正文达到/)
  assert.equal(gates.started(), 8, '达到预算后不再读取下一批')
  assert.ok(peakOpenFiles <= 8)
  assert.equal(openFiles, 0)
  assert.ok(snapshot.entries[0]!.path.startsWith(root))
})

function firstBatchGates(t: TestContext) {
  const ready = deferred()
  const gates = Array.from({ length: 8 }, deferred)
  let started = 0
  let active = 0
  let peak = 0
  const release = () => { for (const gate of [...gates].reverse()) gate.resolve() }
  t.signal.addEventListener('abort', () => { release(); ready.resolve() }, { once: true })
  return {
    ready: ready.promise, release, started: () => started, peak: () => peak,
    enter: async () => {
      const index = started++
      peak = Math.max(peak, ++active)
      if (started === 8) ready.resolve()
      await gates[index]?.promise
      active--
    },
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'whycode-skill-concurrency-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  const skillRoot = join(project, '.agents', 'skills')
  await mkdir(join(project, '.git'), { recursive: true })
  const paths: string[] = []
  for (let index = 0; index < 10; index++) {
    const name = `skill-${String(index).padStart(2, '0')}`
    const directory = join(skillRoot, name)
    await mkdir(directory, { recursive: true })
    const path = join(directory, 'SKILL.md')
    await writeFile(path, document(name))
    paths.push(path)
  }
  return { root, project, skillRoot, paths }
}

function document(name: string): string {
  return `---\nname: ${name}\ndescription: Test concurrency\n---\nInstruction.`
}
