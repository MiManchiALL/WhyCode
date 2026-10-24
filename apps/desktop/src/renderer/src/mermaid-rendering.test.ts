import assert from 'node:assert/strict'
import { it } from 'node:test'
import { mermaidSourceTooLarge, renderMermaid } from './mermaid-rendering.ts'

it('图表预算在加载 Mermaid 前拒绝过长源码与过多行，原文保持完整', async () => {
  const large = 'flowchart TD\n' + 'a'.repeat(20_000)
  assert.equal(mermaidSourceTooLarge('flowchart TD\nA --> B'), false)
  assert.equal(mermaidSourceTooLarge('x'.repeat(20_000)), false)
  assert.equal(mermaidSourceTooLarge(large), true)
  assert.equal(mermaidSourceTooLarge('A\n'.repeat(500)), true)
  await assert.rejects(renderMermaid(large, new AbortController().signal), /图表过大/u)
  assert.equal(large.length, 20_013)
})

it('切换会话取消排队图表，不加载 DOM 渲染器且不会阻塞后续队列', async () => {
  const controller = new AbortController()
  const pending = renderMermaid('flowchart TD\nA --> B', controller.signal)
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  await assert.rejects(renderMermaid('x'.repeat(20_001), new AbortController().signal), /图表过大/u)
})
