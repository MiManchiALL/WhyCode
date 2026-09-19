import assert from 'node:assert/strict'
import { it } from 'node:test'
import { parseHTML } from 'linkedom'
import { buildFileDiffHunks, contentLines } from './file-change-presentation.ts'
import { escapeCodeHtml, renderCodeLines } from './syntax-code-html.ts'

function body(html: string) {
  return parseHTML(`<html><body>${html}</body></html>`).document.body
}

it('source is inert text, including HTML tags, entities, quotes, tabs and Unicode', () => {
  assert.equal(body(`<code>${escapeCodeHtml('a\rb')}</code>`).textContent, 'a\rb')
  const source = `<script>globalThis.executed = true</script>
<img src=x onerror="alert(1)"> &amp; '中文'
	const emoji = "😀";

last line`
  const view = body(renderCodeLines(contentLines(source), null, null))
  assert.equal(view.querySelector('script, img'), null)
  assert.deepEqual([...view.querySelectorAll('code')].map(node => node.textContent),
    source.split('\n').map(line => line || ' '))
  assert.deepEqual([...view.querySelectorAll('.wc-code-line-number')].map(node => node.textContent), ['1', '2', '3', '4', '5'])
  assert.equal(view.querySelectorAll('.wc-code-line').length, 5)
})

it('highlighted HTML retains syntax style without interpreting token content or attributes', () => {
  const text = `</span><img onerror="alert(1)" src=x> & "quoted"`
  const style = `color:red" onmouseover="alert(1)`
  const highlighted = [`<span style="${escapeCodeHtml(style)}">${escapeCodeHtml(text)}</span>`]
  const view = body(renderCodeLines(contentLines(text), highlighted, 1))
  assert.equal(view.querySelector('code')!.textContent, text)
  assert.equal(view.querySelector('img, [onmouseover]'), null)
  assert.equal(view.querySelector('code span')!.getAttribute('style'), style)
  assert.equal(view.querySelector('[data-focus-line="1"]')!.getAttribute('data-tone'), 'context')
})

it('diff rows retain both line number sequences and focus the new version', () => {
  const hunk = buildFileDiffHunks('before\nstays', 'after\nstays')[0]!
  const view = body(renderCodeLines(hunk.lines, null, 1))
  assert.deepEqual([...view.querySelectorAll('.wc-code-line')].map(node => [
    node.getAttribute('data-tone'), node.querySelector('.wc-code-line-number')!.textContent,
  ]), [['removed', '1'], ['added', '1'], ['context', '2']])
  assert.equal(view.querySelectorAll('[data-focus-line]').length, 1)
  assert.equal(view.querySelector('[data-focus-line]')!.getAttribute('data-tone'), 'added')
  assert.equal(body(renderCodeLines([], null, null)).textContent, '空文件')
})

it('long code keeps every line, highlight and focus target across rendering groups', () => {
  const source = Array.from({ length: 130 }, (_, index) => `line ${index + 1}`)
  const highlighted = source.map(text => `<span style="color:red">${text}</span>`)
  const view = body(renderCodeLines(contentLines(source.join('\n')), highlighted, 65))
  assert.deepEqual([...view.querySelectorAll('code')].map(node => node.textContent), source)
  assert.deepEqual([...view.querySelectorAll('.wc-code-line-number')].map(node => node.textContent), source.map((_, index) => String(index + 1)))
  const focused = view.querySelector('[data-focus-line="65"]')!
  assert.equal(focused.querySelector('code span')!.textContent, 'line 65')
  assert.equal(focused.querySelector('code span')!.getAttribute('style'), 'color:red')
  assert.equal(view.querySelectorAll('code span').length, 130)
})
