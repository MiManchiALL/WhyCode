import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { CUSTOM_SYSTEM_PROMPT_MAX_BYTES } from '@whycode/core'
import {
  ensureCustomSystemPromptTemplate,
  getCustomSystemPromptConfigPath,
  loadCustomSystemPromptSnapshot,
} from './custom-system-prompt.ts'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })))
})

describe('自定义 System 文件快照', () => {
  it('首次生成关闭模板，并且不覆盖之后的用户配置与正文', async () => {
    const root = await createRoot()
    const configPath = getCustomSystemPromptConfigPath(join(root, 'config.json'))
    const promptPath = join(root, 'SYSTEM.md')

    assert.equal(await ensureCustomSystemPromptTemplate(configPath), true)
    assert.deepEqual(
      JSON.parse(await readFile(configPath, 'utf8')),
      { mode: 'off', file: 'SYSTEM.md' },
    )
    assert.equal(await readFile(promptPath, 'utf8'), '')

    await writeFile(configPath, '{"mode":"replace","file":"SYSTEM.md"}\n', 'utf8')
    await writeFile(promptPath, '用户正文', 'utf8')
    assert.equal(await ensureCustomSystemPromptTemplate(configPath), false)
    assert.equal(
      await readFile(configPath, 'utf8'),
      '{"mode":"replace","file":"SYSTEM.md"}\n',
    )
    assert.equal(await readFile(promptPath, 'utf8'), '用户正文')
  })

  it('已存在的默认正文不会被首次配置模板覆盖', async () => {
    const root = await createRoot()
    const configPath = getCustomSystemPromptConfigPath(join(root, 'config.json'))
    await writeFile(join(root, 'SYSTEM.md'), '预先写好的正文', 'utf8')

    assert.equal(await ensureCustomSystemPromptTemplate(configPath), true)
    assert.equal(await readFile(join(root, 'SYSTEM.md'), 'utf8'), '预先写好的正文')
  })

  it('off 或配置不存在时不读取正文文件', async () => {
    const root = await createRoot()
    const configPath = getCustomSystemPromptConfigPath(join(root, 'config.json'))
    assert.equal(await loadCustomSystemPromptSnapshot(configPath), undefined)

    await writeFile(
      configPath,
      '{"mode":"off","file":"missing.md"}\n',
      'utf8',
    )
    assert.equal(await loadCustomSystemPromptSnapshot(configPath), undefined)
  })

  it('相对路径以独立配置所在目录为基准并保留原文', async () => {
    const root = await createRoot()
    const configPath = getCustomSystemPromptConfigPath(join(root, 'config.json'))
    await writeFile(
      configPath,
      '{"mode":"append","file":"SYSTEM.md"}\n',
      'utf8',
    )
    await writeFile(join(root, 'SYSTEM.md'), '第一行\r\n第二行\n', 'utf8')

    const snapshot = await loadCustomSystemPromptSnapshot(configPath)

    assert.deepEqual(snapshot, {
      mode: 'append',
      content: '第一行\r\n第二行\n',
    })
  })

  it('拒绝损坏或包含未知字段的独立配置', async () => {
    const root = await createRoot()
    const configPath = getCustomSystemPromptConfigPath(join(root, 'config.json'))

    await writeFile(configPath, '{"mode":', 'utf8')
    await assert.rejects(
      loadCustomSystemPromptSnapshot(configPath),
      /不是有效的 JSON/,
    )

    await writeFile(
      configPath,
      '{"mode":"off","file":"SYSTEM.md","enabled":false}',
      'utf8',
    )
    await assert.rejects(
      loadCustomSystemPromptSnapshot(configPath),
      /配置格式错误/,
    )

    await writeFile(configPath, Buffer.from([0xff]))
    await assert.rejects(
      loadCustomSystemPromptSnapshot(configPath),
      /配置不是有效的 UTF-8/,
    )

    await writeFile(configPath, ' '.repeat(16 * 1024 + 1), 'utf8')
    await assert.rejects(
      loadCustomSystemPromptSnapshot(configPath),
      /配置超过/,
    )
  })

  it('拒绝空文件、非 UTF-8 与超过固定上限的正文', async () => {
    const root = await createRoot()
    const configPath = getCustomSystemPromptConfigPath(join(root, 'config.json'))
    const filePath = join(root, 'SYSTEM.md')
    await writeFile(
      configPath,
      JSON.stringify({ mode: 'replace', file: filePath }),
      'utf8',
    )

    await writeFile(filePath, ' \n', 'utf8')
    await assert.rejects(
      loadCustomSystemPromptSnapshot(configPath),
      /不能为空/,
    )

    await writeFile(filePath, Buffer.from([0xff]))
    await assert.rejects(
      loadCustomSystemPromptSnapshot(configPath),
      /UTF-8/,
    )

    await writeFile(filePath, 'a'.repeat(CUSTOM_SYSTEM_PROMPT_MAX_BYTES + 1), 'utf8')
    await assert.rejects(
      loadCustomSystemPromptSnapshot(configPath),
      /超过/,
    )
  })
})

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'whycode-system-prompt-'))
  tempRoots.push(root)
  return root
}
