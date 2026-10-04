import { $applyNodeReplacement, TextNode, type EditorConfig, type NodeKey, type SerializedTextNode, type LexicalNode } from 'lexical'
import type { PathReference } from './path-reference.ts'

interface SerializedPathReference extends SerializedTextNode {
  reference: PathReference
  source: string
}

export class PathReferenceNode extends TextNode {
  __reference: PathReference
  __source: string

  static override getType(): string { return 'path-reference' }
  static override clone(node: PathReferenceNode): PathReferenceNode {
    return new PathReferenceNode(node.__reference, node.__source, node.__key)
  }
  static override importJSON(value: SerializedPathReference): PathReferenceNode {
    return $createPathReferenceNode(value.reference, value.source).updateFromJSON(value)
  }

  constructor(reference: PathReference, source: string, key?: NodeKey) {
    super(reference.name, key)
    this.__reference = reference
    this.__source = source
  }

  override createDOM(config: EditorConfig): HTMLElement {
    const element = super.createDOM(config)
    // 图标由伪元素绘制，保留 TextNode 的文字节点以支持原生选区和输入法。
    element.className = 'wc-path-reference'
    element.dataset.kind = this.__reference.kind
    element.title = this.__reference.path
    element.spellcheck = false
    return element
  }

  override exportJSON(): SerializedPathReference {
    return { ...super.exportJSON(), type: 'path-reference', version: 1, reference: this.__reference, source: this.__source }
  }

  getSource(): string { return this.getLatest().__source }
  override isTextEntity(): true { return true }
  override canInsertTextBefore(): false { return false }
  override canInsertTextAfter(): false { return false }
}

export function $createPathReferenceNode(reference: PathReference, source: string): PathReferenceNode {
  return $applyNodeReplacement(new PathReferenceNode(reference, source).setMode('token'))
}

export function $isPathReferenceNode(node: LexicalNode): node is PathReferenceNode {
  return node instanceof PathReferenceNode
}
