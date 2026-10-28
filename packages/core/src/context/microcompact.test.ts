import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ModelMessage, ToolResultPart } from 'ai'
import { microcompact, TOOL_RESULT_PRUNED } from './microcompact.ts'

describe('工具结果字符剪枝', () => {
  it('不清空任何短结果，包括很早的结果；恰好 8192 码点不剪枝', () => {
    assert.equal(microcompact(Array.from({ length: 20 }, (_, i) => result(`${i}`, '😀'.repeat(8192)))), null)
  })

  it('超过阈值保留前 4096 和后 1024 码点，幂等且不修改输入', () => {
    const text = '😀'.repeat(4096) + '中'.repeat(4096) + '尾'.repeat(1024)
    const messages = [result('old', '短结果'), result('new', text)]
    const before = structuredClone(messages)
    const compacted = microcompact(messages)!
    assert.deepEqual(messages, before)
    assert.equal(compacted[0], messages[0])
    assert.equal(output(compacted[1]!).type, 'text')
    assert.equal((output(compacted[1]!) as { value: string }).value,
      '😀'.repeat(4096) + TOOL_RESULT_PRUNED + '尾'.repeat(1024))
    assert.equal(microcompact(compacted), null)
  })

  it('ReadFile PDF 文字、图片和多模态结果均不剪枝', () => {
    const messages: ModelMessage[] = []
    for (const path of ['paper.pdf', 'attachment://11111111-1111-4111-8111-111111111111', 'image.png']) {
      messages.push({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: path,
        toolName: 'ReadFile', input: { path } }] }, result(path, '文'.repeat(20_000), 'ReadFile'))
    }
    messages.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'browser', toolName: 'Browser',
      output: { type: 'content', value: [{ type: 'text', text: '说明'.repeat(20_000) },
        { type: 'file', data: { type: 'data', data: 'image-data' }, mediaType: 'image/png' }] } }] })
    assert.equal(microcompact(messages), null)
  })

  it('多个纯文本块共享一次预算，Skill 参考资料和其它文本工具同样适用', () => {
    const messages: ModelMessage[] = [{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'skill', toolName: 'Skill',
      output: { type: 'content', value: [{ type: 'text', text: 'A'.repeat(5000) }, { type: 'text', text: 'B'.repeat(5000) }] } }] }]
    assert.deepEqual(output(microcompact(messages)![0]!), { type: 'content', value: [
      { type: 'text', text: 'A'.repeat(4096) + TOOL_RESULT_PRUNED + 'B'.repeat(1024) },
    ] })
  })
})

function result(id: string, text: string, toolName = 'RunCommand'): ModelMessage {
  return { role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName, output: { type: 'text', value: text } }] }
}
function output(message: ModelMessage): ToolResultPart['output'] {
  assert.equal(message.role, 'tool')
  return (message.content as ToolResultPart[])[0]!.output
}
