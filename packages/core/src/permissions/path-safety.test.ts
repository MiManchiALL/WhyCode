import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { findOutsideBoundary } from './path-safety.ts'

const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir'

describe('路径边界的真实路径校验', () => {
  it('允许以目录联接作为工作区根', async () => {
    const fixture = await createFixture()
    try {
      const workspaceLink = join(fixture.root, 'workspace-link')
      await symlink(fixture.workspace, workspaceLink, directoryLinkType)

      assert.equal(
        findOutsideBoundary(join('src', 'index.ts'), workspaceLink, []),
        null,
      )
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('允许显式授权的目录联接且不把真实目标路径一并授权', async () => {
    const fixture = await createFixture()
    try {
      const authorizedLink = join(fixture.root, 'authorized-link')
      const nestedFile = join(fixture.authorized, 'docs', 'guide.md')
      await mkdir(join(fixture.authorized, 'docs'), { recursive: true })
      await writeFile(nestedFile, '# guide')
      await symlink(fixture.authorized, authorizedLink, directoryLinkType)

      assert.equal(
        findOutsideBoundary(join(authorizedLink, 'docs', 'guide.md'), fixture.workspace, [
          authorizedLink,
        ]),
        null,
      )
      assert.equal(
        findOutsideBoundary(
          join(authorizedLink, 'future', 'nested', 'file.txt'),
          fixture.workspace,
          [authorizedLink],
        ),
        null,
      )
      assert.equal(
        findOutsideBoundary(nestedFile, fixture.workspace, [authorizedLink]),
        resolve(nestedFile),
      )
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('拒绝从允许根内经目录联接逃逸，包括尚不存在的后代路径', async () => {
    const fixture = await createFixture()
    try {
      const authorizedLink = join(fixture.root, 'authorized-link')
      const escapeLink = join(fixture.authorized, 'escape')
      await symlink(fixture.authorized, authorizedLink, directoryLinkType)
      await symlink(fixture.outside, escapeLink, directoryLinkType)

      for (const candidate of [
        join(authorizedLink, 'escape', 'secret.txt'),
        join(authorizedLink, 'escape', 'future', 'nested', 'file.txt'),
      ]) {
        assert.equal(
          findOutsideBoundary(candidate, fixture.workspace, [authorizedLink]),
          resolve(candidate),
        )
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
})

async function createFixture(): Promise<{
  root: string
  workspace: string
  authorized: string
  outside: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'whycode-path-safety-'))
  const workspace = join(root, 'workspace')
  const authorized = join(root, 'authorized')
  const outside = join(root, 'outside')
  await Promise.all([
    mkdir(join(workspace, 'src'), { recursive: true }),
    mkdir(authorized, { recursive: true }),
    mkdir(outside, { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(workspace, 'src', 'index.ts'), ''),
    writeFile(join(outside, 'secret.txt'), 'secret'),
  ])
  return { root, workspace, authorized, outside }
}
