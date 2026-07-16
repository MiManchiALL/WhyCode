import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { SessionStore } from '../session/store.ts'
import { cleanupUnreferencedAttachments } from '../attachments/cleanup.ts'
import { preparePdfAttachmentImport, validateStoredPdfAttachments } from './storage.ts'
import type { PdfProcessor } from './processor.ts'

const SESSION_ID = '11111111-1111-4111-8111-111111111111'
const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })))
})

describe('PDF 附件存储', () => {
  it('先在私有 staging 校验，commit 后才公开稳定文件', async () => {
    const root = await tempDirectory()
    const source = join(root, 'report.pdf')
    const attachments = join(root, 'attachments')
    await writeFile(source, '%PDF-1.4\nwhycode-test')

    const transaction = await preparePdfAttachmentImport(
      [{ kind: 'path', path: source }],
      attachments,
      SESSION_ID,
      fakeProcessor(3),
      new AbortController().signal,
    )
    const [attachment] = transaction.attachments
    assert.ok(attachment)
    assert.equal(attachment.name, 'report.pdf')
    assert.equal(attachment.pageCount, 3)
    assert.equal((await readdir(attachments)).some((name) => name.startsWith('.pdf-import-')), true)

    await transaction.commit()
    assert.deepEqual(await readdir(attachments), [attachment.storageName])
    assert.equal(await readFile(join(attachments, attachment.storageName), 'utf8'), '%PDF-1.4\nwhycode-test')
    await validateStoredPdfAttachments(
      attachments,
      SESSION_ID,
      transaction.attachments,
      fakeProcessor(3),
      new AbortController().signal,
    )
  })

  it('按字节摘要拒绝不同路径的重复 PDF，并清空失败 staging', async () => {
    const root = await tempDirectory()
    const first = join(root, 'first.pdf')
    const second = join(root, 'second.pdf')
    const attachments = join(root, 'attachments')
    await Promise.all([
      writeFile(first, '%PDF-1.4\nsame'),
      writeFile(second, '%PDF-1.4\nsame'),
    ])

    await assert.rejects(
      preparePdfAttachmentImport(
        [{ kind: 'path', path: first }, { kind: 'path', path: second }],
        attachments,
        SESSION_ID,
        fakeProcessor(1),
        new AbortController().signal,
      ),
      /同一个 PDF 不能重复添加/,
    )
    assert.deepEqual(await readdir(attachments), [])
  })

  it('统一清理保留事实源 PDF，并移除跨类型孤儿文件和 staging', async () => {
    const root = await tempDirectory()
    const source = join(root, 'keep.pdf')
    const attachments = join(root, 'attachments')
    await writeFile(source, '%PDF-1.4\nkeep')
    const transaction = await preparePdfAttachmentImport(
      [{ kind: 'path', path: source }],
      attachments,
      SESSION_ID,
      fakeProcessor(1),
      new AbortController().signal,
    )
    await transaction.commit()
    await Promise.all([
      writeFile(join(attachments, 'orphan.png'), 'orphan'),
      mkdir(join(attachments, '.image-import-orphan')),
      mkdir(join(attachments, '.pdf-import-orphan')),
    ])

    await cleanupUnreferencedAttachments(attachments, {
      imageAttachments: [],
      pdfAttachments: transaction.attachments,
    })
    assert.deepEqual(await readdir(attachments), [transaction.attachments[0]!.storageName])
  })

  it('随用户输入持久化引用，并在恢复时重新校验磁盘字节', async () => {
    const root = await tempDirectory()
    const source = join(root, 'guide.pdf')
    const sessionsRoot = join(root, 'sessions')
    await writeFile(source, '%PDF-1.4\npersistent')
    const processor = fakeProcessor(8)
    const store = new SessionStore(sessionsRoot, { pdfProcessor: processor })
    const journal = await store.create({ projectDir: null, modelId: 'test:model' })
    const transaction = await preparePdfAttachmentImport(
      [{ kind: 'path', path: source }],
      journal.attachmentDirectory,
      journal.sessionId,
      processor,
      new AbortController().signal,
    )
    await transaction.commit()
    await journal.recordUserInput('总结文档', true, [], transaction.attachments)

    const reopened = await store.open(journal.sessionId)
    assert.equal(reopened.initialPdfAttachments[0]?.pageCount, 8)
    assert.match(JSON.stringify(reopened.initialMessages), new RegExp(transaction.attachments[0]!.id))
    const userEvent = reopened.initialViewEvents.find((event) => event.type === 'user-message')
    assert.equal(userEvent?.type === 'user-message' && userEvent.pdfAttachments?.length, 1)

    await writeFile(
      join(reopened.attachmentDirectory, transaction.attachments[0]!.storageName),
      '%PDF-1.4\ntampered',
    )
    await assert.rejects(store.open(journal.sessionId), /元数据与磁盘文件不一致/)
  })
})

function fakeProcessor(pageCount: number): PdfProcessor {
  return {
    async inspect(path) {
      const info = await stat(path)
      return { pageCount, byteLength: info.size }
    },
    async readPages() {
      throw new Error('本测试不读取页面')
    },
  }
}

async function tempDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'whycode-pdf-storage-'))
  tempDirectories.push(path)
  return path
}
