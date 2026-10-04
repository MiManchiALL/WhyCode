import {
  $addUpdateTag, $createLineBreakNode, $createParagraphNode, $createTextNode, $getRoot, $getSelection, HISTORY_PUSH_TAG,
  $isElementNode, $isRangeSelection, $isTextNode, type LexicalNode, type PointType, type RangeSelection,
} from 'lexical'
import { pathReferenceText, splitPathReferences, type PathReference } from './path-reference.ts'
import { $createPathReferenceNode, $isPathReferenceNode } from './path-reference-node.ts'

export function $composerText(node: LexicalNode = $getRoot()): string {
  if ($isPathReferenceNode(node)) return node.getSource()
  if (!$isElementNode(node)) return node.getTextContent()
  return node.getChildren().map($composerText).join(node.getType() === 'root' ? '\n\n' : '')
}

export function $composerNodes(text: string): LexicalNode[] {
  return splitPathReferences(text).flatMap<LexicalNode>(part => part.reference
    ? [$createPathReferenceNode(part.reference, part.text)]
    : part.text.split('\n').flatMap((line, index) => [
      ...(index ? [$createLineBreakNode()] : []), ...(line ? [$createTextNode(line)] : []),
    ]))
}

export function $replaceComposerText(text: string): void {
  $getRoot().clear().append($createParagraphNode().append(...$composerNodes(text)))
}

export function $appendPathReference(reference: PathReference): void {
  $addUpdateTag(HISTORY_PUSH_TAG)
  const text = $composerText()
  $getRoot().selectEnd().insertNodes([
    ...(text && !/\s$/u.test(text) ? [$createTextNode(' ')] : []),
    $createPathReferenceNode(reference, pathReferenceText(reference)), $createTextNode(' '),
  ])
}

function $pointOffset(point: PointType, tokenEnd: boolean): number {
  let node: LexicalNode = point.getNode()
  let offset = $isElementNode(node)
    ? node.getChildren().slice(0, point.offset).map($composerText).join(node.getType() === 'root' ? '\n\n' : '').length
    : $isPathReferenceNode(node)
      ? (point.offset >= node.getTextContentSize() || (tokenEnd && point.offset > 0) ? node.getSource().length : 0)
      : point.offset
  if (node.getType() === 'root' && point.offset > 0 && point.offset < $getRoot().getChildrenSize()) offset += 2
  for (let parent = node.getParent(); parent; parent = node.getParent()) {
    const previous = parent.getChildren().slice(0, node.getIndexWithinParent())
    offset += previous.reduce((size, sibling) => size + $composerText(sibling).length + (parent.getType() === 'root' ? 2 : 0), 0)
    node = parent
  }
  return offset
}

export function $composerCursor(): number | null {
  const selection = $getSelection()
  return $isRangeSelection(selection) && selection.isCollapsed() ? $pointOffset(selection.anchor, true) : null
}

export function $composerSelectionText(selection: RangeSelection): string {
  const [start, end] = selection.isBackward() ? [selection.focus, selection.anchor] : [selection.anchor, selection.focus]
  return $composerText().slice($pointOffset(start, false), $pointOffset(end, true))
}

/** 斜杠菜单仍使用发送文本的偏移；路径节点只能定位到整体之前或之后。 */
export function $selectComposerOffset(offset: number): void {
  const visit = (node: LexicalNode): boolean => {
    if ($isElementNode(node)) {
      for (const [index, child] of node.getChildren().entries()) {
        if (index && node.getType() === 'root') offset -= 2
        if (visit(child)) return true
      }
    } else {
      const size = $composerText(node).length
      if (offset <= size) {
        if ($isTextNode(node)) {
          const position = $isPathReferenceNode(node) ? (offset > 0 ? node.getTextContentSize() : 0) : Math.max(0, offset)
          node.select(position, position)
        } else if (offset > 0) node.selectNext(0, 0)
        else node.selectPrevious()
        return true
      }
      offset -= size
    }
    return false
  }
  if (!visit($getRoot())) $getRoot().selectEnd()
}
