import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  localWorkspace,
  SessionStore,
  USER_IMAGE_ATTACHMENT_MAX_COUNT,
  type PdfProcessor,
} from '@whycode/core'
import {
  prepareUserMessageAttachments,
  userMessageNeedsAttachmentPreparation,
} from './user-message-attachments.ts'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)
const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })))
})

describe('桌面混合附件准备', () => {
  it('纯文本绕过附件准备锁，附件与恢复输入才进入事务', () => {
    assert.equal(userMessageNeedsAttachmentPreparation({
      type: 'user-message',
      text: '快速追问',
    }), false)
    assert.equal(userMessageNeedsAttachmentPreparation({
      type: 'user-message',
      text: '',
      pdfAttachments: [{ kind: 'path', path: 'guide.pdf' }],
    }), true)
    assert.equal(userMessageNeedsAttachmentPreparation({
      type: 'user-message',
      text: '重提',
      restoredInputIds: ['11111111-1111-4111-8111-111111111111'],
    }), true)
  })

  it('把图片和 PDF 作为同一事务准备，并保留各自稳定元数据', async () => {
    const root = await tempDirectory()
    const imagePath = join(root, 'screen.png')
    const pdfPath = join(root, 'guide.pdf')
    await Promise.all([
      writeFile(imagePath, ONE_PIXEL_PNG),
      writeFile(pdfPath, '%PDF-1.4\nguide'),
    ])
    const journal = await new SessionStore(join(root, 'sessions')).create({
      workspace: localWorkspace(root),
      modelId: 'test:vision',
    })
    const prepared = await prepareUserMessageAttachments({
      command: {
        type: 'user-message',
        text: '分析附件',
        attachments: [{ kind: 'path', path: imagePath }],
        pdfAttachments: [{ kind: 'path', path: pdfPath }],
      },
      journal,
      pdfProcessor: fakeProcessor(),
      imageInputMode: 'native',
      modelDisplayName: 'Vision',
      abortSignal: new AbortController().signal,
    })

    assert.equal(prepared.attachments.length, 1)
    assert.equal(prepared.pdfAttachments[0]?.pageCount, 2)
    assert.equal(prepared.importedFiles, true)
    assert.deepEqual((await readdir(journal.attachmentDirectory)).sort(), [
      prepared.attachments[0]!.storageName,
      prepared.pdfAttachments[0]!.storageName,
    ].sort())
  })

  it('非视觉模型配置辅助识图后接受图片，并把交付方式冻结为 auxiliary', async () => {
    const root = await tempDirectory()
    const imagePath = join(root, 'screen.png')
    await writeFile(imagePath, ONE_PIXEL_PNG)
    const journal = await new SessionStore(join(root, 'sessions')).create({
      workspace: localWorkspace(root),
      modelId: 'test:text',
    })
    const prepared = await prepareUserMessageAttachments({
      command: {
        type: 'user-message',
        text: '分析图片',
        attachments: [{ kind: 'path', path: imagePath }],
      },
      journal,
      pdfProcessor: fakeProcessor(),
      imageInputMode: 'auxiliary',
      modelDisplayName: 'Text Model',
      abortSignal: new AbortController().signal,
    })
    assert.equal(prepared.attachments.length, 1)
    assert.equal(prepared.imageDelivery, 'auxiliary')
  })

  it('PDF 校验失败会回收同批已准备图片，不留下半事务', async () => {
    const root = await tempDirectory()
    const imagePath = join(root, 'screen.png')
    const pdfPath = join(root, 'broken.pdf')
    await Promise.all([
      writeFile(imagePath, ONE_PIXEL_PNG),
      writeFile(pdfPath, '%PDF-1.4\nbroken'),
    ])
    const journal = await new SessionStore(join(root, 'sessions')).create({
      workspace: localWorkspace(root),
      modelId: 'test:vision',
    })
    const processor: PdfProcessor = {
      async inspect() { throw new Error('PDF 无法解析') },
      async readPages() { throw new Error('unused') },
    }
    await assert.rejects(
      prepareUserMessageAttachments({
        command: {
          type: 'user-message',
          text: '分析附件',
          attachments: [{ kind: 'path', path: imagePath }],
          pdfAttachments: [{ kind: 'path', path: pdfPath }],
        },
        journal,
        pdfProcessor: processor,
        imageInputMode: 'native',
        modelDisplayName: 'Vision',
        abortSignal: new AbortController().signal,
      }),
      /PDF 无法解析/,
    )
    assert.deepEqual(await readdir(journal.attachmentDirectory), [])
  })

  it('非视觉模型允许 PDF，但在复制图片前拒绝图片输入', async () => {
    const root = await tempDirectory()
    const pdfPath = join(root, 'text.pdf')
    await writeFile(pdfPath, '%PDF-1.4\ntext')
    const journal = await new SessionStore(join(root, 'sessions')).create({
      workspace: localWorkspace(null),
      modelId: 'test:text',
    })
    const common = {
      journal,
      pdfProcessor: fakeProcessor(),
      imageInputMode: 'none' as const,
      modelDisplayName: 'Text Model',
      abortSignal: new AbortController().signal,
    }
    const pdf = await prepareUserMessageAttachments({
      ...common,
      command: {
        type: 'user-message' as const,
        text: '读取',
        pdfAttachments: [{ kind: 'path' as const, path: pdfPath }],
      },
    })
    assert.equal(pdf.pdfAttachments.length, 1)

    await assert.rejects(
      prepareUserMessageAttachments({
        ...common,
        command: {
          type: 'user-message',
          text: '图片',
          attachments: [{ kind: 'path', path: join(root, 'missing.png') }],
        },
      }),
      /Text Model 不支持原生识图/,
    )
  })

  it('在读取文件前拒绝单条消息的第十一张图片', async () => {
    const root = await tempDirectory()
    const journal = await new SessionStore(join(root, 'sessions')).create({
      workspace: localWorkspace(root),
      modelId: 'test:vision',
    })

    await assert.rejects(
      prepareUserMessageAttachments({
        command: {
          type: 'user-message',
          text: '分析多张图片',
          attachments: Array.from({
            length: USER_IMAGE_ATTACHMENT_MAX_COUNT + 1,
          }, (_, index) => ({
            kind: 'path' as const,
            path: join(root, `missing-${index}.png`),
          })),
        },
        journal,
        pdfProcessor: fakeProcessor(),
        imageInputMode: 'native',
        modelDisplayName: 'Vision',
        abortSignal: new AbortController().signal,
      }),
      new RegExp(`每条消息最多添加 ${USER_IMAGE_ATTACHMENT_MAX_COUNT} 张图片`),
    )
    await assert.rejects(readdir(journal.attachmentDirectory), { code: 'ENOENT' })
  })
})

function fakeProcessor(): PdfProcessor {
  return {
    async inspect(path) {
      return { pageCount: 2, byteLength: (await stat(path)).size }
    },
    async readPages() {
      throw new Error('unused')
    },
  }
}

async function tempDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'whycode-message-attachments-'))
  tempDirectories.push(path)
  return path
}
