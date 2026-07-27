import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { MCP_TOOL_OUTPUT_MAX_BYTES, formatMcpToolResult } from './output.ts'

const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

describe('MCP 工具结果适配', () => {
  it('保留文本、结构化结果和文本资源，但不暴露 _meta', async () => {
    const result = await formatMcpToolResult({
      content: [
        { type: 'text', text: 'hello', _meta: { secret: 'hidden-a' } },
        { type: 'resource', resource: { uri: 'memo://one', text: 'resource text' } },
        { type: 'audio', data: 'abc', mimeType: 'audio/wav' },
      ],
      structuredContent: { count: 1 },
      _meta: { token: 'hidden-b' },
    }, undefined, new AbortController().signal)

    assert.equal(result.isError, false)
    assert.match(result.data, /hello/)
    assert.match(result.data, /resource text/)
    assert.match(result.data, /"count": 1/)
    assert.match(result.data, /尚不支持/)
    assert.doesNotMatch(result.data, /hidden-a|hidden-b/)
  })

  it('在统一输出边界隐藏文本、结构化结果和资源 URI 中的 URL 凭据', async () => {
    const result = await formatMcpToolResult({
      content: [
        {
          type: 'text',
          text: [
            'download=https://raw.example.test/private?ref=main&token=text-token',
            'public=https://example.test/docs?language=zh&version=1',
          ].join('\n'),
        },
        {
          type: 'resource',
          resource: {
            uri: 'repo://private/file?access_token=resource-token',
            text: 'mirror=https://user:password@example.test/file',
          },
        },
        {
          type: 'resource_link',
          name: 'private resource',
          uri: 'https://bucket.example.test/file?X-Amz-Signature=resource-signature',
        },
      ],
      structuredContent: {
        download_url: 'https://raw.example.test/file?token=structured-token',
        callback: 'https://auth.example.test/callback#access_token=fragment-token',
      },
    }, undefined, new AbortController().signal)

    assert.doesNotMatch(
      result.data,
      /text-token|resource-token|password|resource-signature|structured-token|fragment-token/u,
    )
    assert.match(result.data, /token=REDACTED/u)
    assert.match(result.data, /access_token=REDACTED/u)
    assert.match(result.data, /X-Amz-Signature=REDACTED/u)
    assert.match(result.data, /https:\/\/example\.test\/docs\?language=zh&version=1/u)
  })

  it('把受支持图片导入现有附件存储，并按固定字节上限截断文本', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-mcp-output-'))
    try {
      const result = await formatMcpToolResult({
        content: [
          { type: 'text', text: '中'.repeat(MCP_TOOL_OUTPUT_MAX_BYTES) },
          { type: 'image', data: ONE_PIXEL_PNG, mimeType: 'image/png' },
        ],
      }, {
        attachmentDirectory: root,
        sessionId: crypto.randomUUID(),
      }, new AbortController().signal)

      assert.equal(result.attachments?.length, 1)
      assert.ok(Buffer.byteLength(result.data, 'utf8') <= MCP_TOOL_OUTPUT_MAX_BYTES)
      assert.match(result.data, /输出已按 64 KiB 上限截断/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('在格式化阶段限制内容项与深层结构，不先构造无界模型文本', async () => {
    const nested: Record<string, unknown> = {}
    let cursor = nested
    for (let index = 0; index < 30; index++) {
      const child: Record<string, unknown> = {}
      cursor.next = child
      cursor = child
    }
    cursor.values = Array.from({ length: 200 }, () => 'x'.repeat(20_000))

    const result = await formatMcpToolResult({
      content: Array.from({ length: 1_000 }, (_, index) => ({
        type: 'text',
        text: `item-${index}`,
      })),
      structuredContent: nested,
    }, undefined, new AbortController().signal)

    assert.ok(Buffer.byteLength(result.data, 'utf8') <= MCP_TOOL_OUTPUT_MAX_BYTES)
    assert.match(result.data, /安全边界/)
    assert.match(result.data, /截断/)
  })

  it('图片附件导入取消时向会话步骤传播取消，不伪装成普通结果', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-mcp-output-abort-'))
    const abort = new AbortController()
    abort.abort()
    try {
      await assert.rejects(
        formatMcpToolResult({
          content: [{ type: 'image', data: ONE_PIXEL_PNG, mimeType: 'image/png' }],
        }, {
          attachmentDirectory: root,
          sessionId: crypto.randomUUID(),
        }, abort.signal),
        /图片处理已取消/u,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
