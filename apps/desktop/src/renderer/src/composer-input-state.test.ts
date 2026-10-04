import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { $getRoot, $getSelection, $isRangeSelection, createEditor } from 'lexical'
import { PathReferenceNode } from './path-reference-node.ts'
import { pathReferenceText } from './path-reference.ts'
import { $appendPathReference, $composerCursor, $composerSelectionText, $composerText, $replaceComposerText, $selectComposerOffset } from './composer-input-state.ts'

const reference = { name: '需求 [最终].md', path: '/home/Lin/project/需求 [最终].md', kind: 'file' } as const
const source = pathReferenceText(reference)

function withEditor(run: () => void) {
  const editor = createEditor({ nodes: [PathReferenceNode], onError: error => { throw error } })
  editor.update(run, { discrete: true })
  return editor
}

describe('路径引用输入文本', () => {
  it('恢复草稿、追加引用和正文往返保持同一发送文本', () => {
    withEditor(() => {
      $replaceComposerText('请检查\n第二行')
      $appendPathReference(reference)
      assert.equal($composerText(), `请检查\n第二行 ${source} `)
      const stored = $composerText()
      $replaceComposerText(stored)
      assert.equal($composerText(), stored)
      assert.equal($getRoot().getAllTextNodes().filter(node => node instanceof PathReferenceNode).length, 1)
    })
  })

  it('引用前后及换行后的光标偏移使用真实路径文本，斜杠菜单可正确删除触发词', () => {
    withEditor(() => {
      const text = `说明 ${source}\n/MCP`
      $replaceComposerText(text)
      for (const offset of [0, 3, 3 + source.length, text.length - 4, text.length]) {
        $selectComposerOffset(offset)
        assert.equal($composerCursor(), offset)
      }
    })
  })

  it('复制和剪切保留完整路径，引用边界的纯文本选区不多带一个引用', () => {
    withEditor(() => {
      $replaceComposerText(`前文 ${source} 后文`)
      const root = $getRoot()
      const nodes = root.getAllTextNodes()
      const token = nodes[1]!
      root.select(0, root.getChildrenSize())
      let selection = $getSelection()
      assert($isRangeSelection(selection))
      assert.equal($composerSelectionText(selection), `前文 ${source} 后文`)
      token.select(token.getTextContentSize(), token.getTextContentSize())
      selection = $getSelection()
      assert($isRangeSelection(selection))
      selection.focus.set(nodes[2]!.getKey(), 3, 'text')
      assert.equal($composerSelectionText(selection), ' 后文')
      token.select(0, token.getTextContentSize())
      selection = $getSelection()
      assert($isRangeSelection(selection))
      assert.equal($composerSelectionText(selection), source)
      selection.removeText()
      assert.equal($composerText(), '前文  后文')
    })
  })
})
