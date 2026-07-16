import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { DEFAULT_WORKSPACE_NAME, ensureDefaultWorkspace } from './workspace.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('默认工作文件夹', () => {
  it('优先在 Documents 中创建用户可见的 WhyCode Workspace', async () => {
    const root = await temporaryRoot()
    const documents = join(root, 'Documents')
    const path = await ensureDefaultWorkspace(documents, join(root, 'user-data'))

    assert.equal(path, await realpath(join(documents, DEFAULT_WORKSPACE_NAME)))
    assert.equal((await stat(path)).isDirectory(), true)
  })

  it('Documents 目标被普通文件占用时退回 userData 私有工作目录', async () => {
    const root = await temporaryRoot()
    const documents = join(root, 'Documents')
    const occupied = join(documents, DEFAULT_WORKSPACE_NAME)
    await mkdir(documents, { recursive: true })
    await writeFile(occupied, 'occupied')

    const path = await ensureDefaultWorkspace(documents, join(root, 'user-data'))
    assert.equal(path, await realpath(join(root, 'user-data', 'workspace')))
    assert.equal((await stat(path)).isDirectory(), true)
  })
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'whycode-workspace-'))
  roots.push(root)
  return root
}
