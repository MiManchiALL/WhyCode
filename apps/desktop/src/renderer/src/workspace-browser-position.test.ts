import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseHTML } from 'linkedom'
import { captureWorkspaceBrowserPosition, restoreWorkspaceBrowserPosition } from './workspace-browser-position.ts'

describe('文件树阅读位置', () => {
  it('记住可见行的路径及偏移，前方插入目录后仍回到同一行', () => {
    const { element, rows } = fixture()
    element.scrollTop = 215
    const position = captureWorkspaceBrowserPosition(element, '/home/Lin')
    assert.deepEqual(position, {
      rootPath: '/home/Lin', scrollTop: 215,
      anchor: { path: 'fpga/notes.txt', offset: 15 }, directories: { '': 400, fpga: 200 },
    })
    rows[1]!.getBoundingClientRect = () => rectangle(320 - element.scrollTop)
    element.scrollTop = 0
    restoreWorkspaceBrowserPosition(element, position)
    assert.equal(element.scrollTop, 335)
  })

  it('目标已删除时回到父目录；目录也消失时限制在剩余滚动范围内', () => {
    const { element, rows } = fixture()
    element.scrollTop = 215
    const position = captureWorkspaceBrowserPosition(element, '/home/Lin')
    rows[1]!.remove()
    element.scrollTop = 0
    restoreWorkspaceBrowserPosition(element, position)
    assert.equal(element.scrollTop, 100)
    rows[0]!.remove()
    Object.defineProperty(element, 'scrollHeight', { value: 220, configurable: true })
    restoreWorkspaceBrowserPosition(element, position)
    assert.equal(element.scrollTop, 120)
  })

  it('空目录只记滚动位置，不产生虚构路径或文件内容', () => {
    const { element, rows } = fixture()
    for (const row of rows) row.remove()
    element.scrollTop = 0
    assert.equal(captureWorkspaceBrowserPosition(element, '/empty').anchor, null)
  })
})

function fixture() {
  const { document } = parseHTML('<main><ul data-directory-path="" data-directory-entries="400"><li><button data-workspace-path="fpga">fpga</button><ul data-directory-path="fpga" data-directory-entries="200"><li><button data-workspace-path="fpga/notes.txt">notes.txt</button></li></ul></li></ul></main>')
  const element = document.querySelector<HTMLElement>('main')!
  Object.defineProperties(element, {
    scrollTop: { value: 0, writable: true },
    scrollHeight: { value: 1000, configurable: true },
    clientHeight: { value: 100 },
  })
  element.getBoundingClientRect = () => rectangle(0, 100)
  const rows = [...element.querySelectorAll<HTMLElement>('button')]
  rows.forEach((row, index) => { row.getBoundingClientRect = () => rectangle((index + 1) * 100 - element.scrollTop) })
  return { element, rows }
}

function rectangle(top: number, height = 30): DOMRect {
  return { top, bottom: top + height, left: 0, right: 100, width: 100, height, x: 0, y: top, toJSON: () => ({}) }
}
