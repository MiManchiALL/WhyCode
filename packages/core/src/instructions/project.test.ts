import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import type { ModelMessage } from 'ai'
import {
  applyProjectInstructions,
  isProjectInstructionsMessage,
  loadProjectInstructions,
  projectInstructionsUpdate,
  projectInstructionsVersion,
} from './project.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe('项目指令发现', () => {
  it('合并全局与 Git 根到当前目录的规则链，并让同目录 override 胜出', async () => {
    const root = await temporaryDirectory()
    const home = join(root, 'home')
    const repository = join(root, 'repository')
    const child = join(repository, 'packages', 'core')
    await mkdir(join(home, '.whycode'), { recursive: true })
    await mkdir(join(repository, '.git'), { recursive: true })
    await mkdir(child, { recursive: true })
    await writeFile(join(home, '.whycode', 'AGENTS.md'), '全局规则', 'utf8')
    await writeFile(join(repository, 'AGENTS.md'), '根规则', 'utf8')
    await writeFile(join(repository, 'packages', 'AGENTS.md'), '包规则', 'utf8')
    await writeFile(join(child, 'AGENTS.md'), '不应采用的普通规则', 'utf8')
    await writeFile(join(child, 'AGENTS.override.md'), '子目录覆盖规则', 'utf8')

    const snapshot = await loadProjectInstructions({ homeDir: home, projectDir: child })
    assert.ok(snapshot)
    const text = messageText(snapshot.message)
    assert.ok(text.indexOf('全局规则') < text.indexOf('根规则'))
    assert.ok(text.indexOf('根规则') < text.indexOf('包规则'))
    assert.ok(text.indexOf('包规则') < text.indexOf('子目录覆盖规则'))
    assert.doesNotMatch(text, /不应采用的普通规则/)
    assert.equal(projectInstructionsVersion(snapshot.message), snapshot.version)
  })

  it('最近 Git 根阻止读取项目外祖先规则，无 Git 时只读取当前目录', async () => {
    const root = await temporaryDirectory()
    const repository = join(root, 'outer', 'repository')
    const child = join(repository, 'child')
    await mkdir(join(repository, '.git'), { recursive: true })
    await mkdir(child, { recursive: true })
    await writeFile(join(root, 'AGENTS.md'), '项目外规则', 'utf8')
    await writeFile(join(repository, 'AGENTS.md'), '项目根规则', 'utf8')
    await writeFile(join(child, 'AGENTS.md'), '当前目录规则', 'utf8')

    const gitSnapshot = await loadProjectInstructions({ projectDir: child })
    assert.ok(gitSnapshot)
    assert.match(messageText(gitSnapshot.message), /项目根规则[\s\S]*当前目录规则/)
    assert.doesNotMatch(messageText(gitSnapshot.message), /项目外规则/)

    const plain = join(root, 'plain', 'child')
    await mkdir(plain, { recursive: true })
    await writeFile(join(root, 'plain', 'AGENTS.md'), '无 Git 祖先规则', 'utf8')
    await writeFile(join(plain, 'AGENTS.md'), '无 Git 当前规则', 'utf8')
    const plainSnapshot = await loadProjectInstructions({ projectDir: plain })
    assert.ok(plainSnapshot)
    assert.match(messageText(plainSnapshot.message), /无 Git 当前规则/)
    assert.doesNotMatch(messageText(plainSnapshot.message), /无 Git 祖先规则/)
  })

  it('没有指令文件时不注入消息', async () => {
    const root = await temporaryDirectory()
    await mkdir(root, { recursive: true })
    assert.equal(await loadProjectInstructions({ projectDir: root }), null)
  })

  it('空的 override 也会遮蔽同目录普通规则', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'AGENTS.md'), '不应采用的普通规则', 'utf8')
    await writeFile(join(root, 'AGENTS.override.md'), '', 'utf8')

    const snapshot = await loadProjectInstructions({ projectDir: root })
    assert.ok(snapshot)
    const text = messageText(snapshot.message)
    assert.match(text, /AGENTS\.override\.md[\s\S]*\[文件为空\]/)
    assert.doesNotMatch(text, /不应采用的普通规则/)
  })

  it('内容变化产生新版本，替换函数始终只保留索引 0 的最新快照', async () => {
    const root = await temporaryDirectory()
    const path = join(root, 'AGENTS.md')
    await writeFile(path, '版本一', 'utf8')
    const first = await loadProjectInstructions({ projectDir: root })
    assert.ok(first)
    await writeFile(path, '版本二', 'utf8')
    const second = await loadProjectInstructions({ projectDir: root })
    assert.ok(second)
    assert.notEqual(first.version, second.version)

    const conversation: ModelMessage[] = [
      { role: 'user', content: '真实请求' },
      first.message,
      { role: 'assistant', content: '已有回答' },
      first.message,
    ]
    const replaced = applyProjectInstructions(conversation, second.message)
    assert.equal(replaced.filter(isProjectInstructionsMessage).length, 1)
    assert.equal(replaced[0], second.message)
    assert.deepEqual(replaced.slice(1).map(messageText), ['真实请求', '已有回答'])
    assert.deepEqual(projectInstructionsUpdate(conversation, second), {
      version: second.version,
      message: second.message,
    })
    assert.equal(projectInstructionsUpdate(replaced, second), null)
  })

  it('总上限优先保留更深层规则，并且不会截断 UTF-8 字符', async () => {
    const root = await temporaryDirectory()
    const child = join(root, 'child')
    await mkdir(join(root, '.git'), { recursive: true })
    await mkdir(child, { recursive: true })
    await writeFile(join(root, 'AGENTS.md'), '根'.repeat(100), 'utf8')
    await writeFile(join(child, 'AGENTS.md'), '子规则', 'utf8')

    const snapshot = await loadProjectInstructions({
      projectDir: child,
      maxContentBytes: Buffer.byteLength('子规则', 'utf8') + Buffer.byteLength('根', 'utf8'),
    })
    assert.ok(snapshot)
    const text = messageText(snapshot.message)
    assert.match(text, /子规则/)
    assert.match(text, /根[\s\S]*截断/)
    assert.doesNotMatch(text, /�/)
  })
})

function messageText(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n')
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'whycode-project-instructions-'))
  temporaryDirectories.push(path)
  return path
}
