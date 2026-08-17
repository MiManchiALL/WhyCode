import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseHTML } from 'linkedom'
import {
  captureConversationScrollPosition,
  restoreConversationScrollPosition,
} from './conversation-scroll.ts'

describe('会话滚动锚定', () => {
  it('长正文用视口附近的顶层 Markdown 内容作为锚点', () => {
    const { document } = parseHTML(`
      <main id="scroll">
        <section data-conversation-scroll-section="work-1">
          <div data-conversation-scroll-block="text-1">
            <div class="wc-markdown"><div><p></p><h2></h2><p></p></div></div>
          </div>
        </section>
      </main>
    `)
    const scroller = document.querySelector<HTMLElement>('#scroll')!
    const section = document.querySelector<HTMLElement>('section')!
    const block = document.querySelector<HTMLElement>('[data-conversation-scroll-block]')!
    const content = [...document.querySelectorAll<HTMLElement>('.wc-markdown > div > *')]
    defineScrollerMetrics(scroller, 500, 2_000, 400)
    defineTop(scroller, 0)
    defineTop(section, -500)
    defineTop(block, -200)
    defineTop(content[0]!, -180)
    defineTop(content[1]!, -20)
    defineTop(content[2]!, 100)

    assert.deepEqual(captureConversationScrollPosition(scroller).anchor, {
      sectionId: 'work-1',
      blockId: 'text-1',
      contentIndex: 1,
      offset: 20,
    })
  })

  it('以实测固有高度防止恢复后截断，并只校准维持目标视口所需的尾段', () => {
    const { document } = parseHTML(`
      <main id="scroll">
        <section class="wc-completed-work-section" data-conversation-scroll-section="work-1"></section>
        <section class="wc-completed-work-section" data-conversation-scroll-section="work-2">
          <div data-conversation-scroll-block="text-2">
            <div class="wc-markdown"><div><p></p><h2></h2></div></div>
          </div>
        </section>
        <section class="wc-completed-work-section" data-conversation-scroll-section="work-3"></section>
        <section class="wc-completed-work-section" data-conversation-scroll-section="work-4"></section>
      </main>
    `)
    const scroller = document.querySelector<HTMLElement>('#scroll')!
    const sections = [...document.querySelectorAll<HTMLElement>('section')]
    const target = document.querySelectorAll<HTMLElement>('.wc-markdown > div > *')[1]!
    const currentScrollTop = defineScrollerMetrics(scroller, 0, () => {
      if (!sections.slice(0, 2).every(hasStableBlockSize)) return 700
      return hasStableBlockSize(sections[2]!) ? 2_000 : 1_100
    }, 400)
    defineTop(scroller, 0)
    defineRectangle(sections[0]!, 0, 500)
    defineRectangle(sections[1]!, 500, 800)
    defineRectangle(sections[2]!, 1_300, 600)
    defineRectangle(sections[3]!, 1_900, 400)
    target.getBoundingClientRect = () => {
      assert.equal(sections[0]!.style.getPropertyValue('content-visibility'), 'visible')
      assert.equal(sections[1]!.style.getPropertyValue('content-visibility'), 'visible')
      assert.equal(sections[0]!.style.getPropertyValue('contain'), 'layout style paint')
      assert.equal(sections[1]!.style.getPropertyValue('contain'), 'layout style paint')
      assert.equal(sections[2]!.style.getPropertyValue('content-visibility'), '')
      return rectangle(800 - currentScrollTop())
    }

    const restored = restoreConversationScrollPosition({
      atBottom: false,
      scrollTop: 300,
      anchor: {
        sectionId: 'work-2',
        blockId: 'text-2',
        contentIndex: 1,
        offset: 120,
      },
    }, scroller)

    assert.equal(restored.scrollTop, 920)
    assert.equal(currentScrollTop(), 920)
    assert.deepEqual(
      sections.map((section) => section.style.getPropertyValue('content-visibility')),
      ['', '', '', ''],
    )
    assert.deepEqual(
      sections.map((section) => section.style.getPropertyValue('contain')),
      ['', '', '', ''],
    )
    assert.deepEqual(
      sections.map((section) => section.style.getPropertyValue('contain-intrinsic-block-size')),
      ['auto 500px', 'auto 800px', 'auto 600px', ''],
    )
  })
})

function hasStableBlockSize(section: HTMLElement): boolean {
  return section.style.getPropertyValue('content-visibility') === 'visible'
    || section.style.getPropertyValue('contain-intrinsic-block-size').startsWith('auto ')
}

function defineScrollerMetrics(
  element: HTMLElement,
  initialScrollTop: number,
  scrollHeight: number | (() => number),
  clientHeight: number,
): () => number {
  let scrollTop = initialScrollTop
  const currentScrollHeight = typeof scrollHeight === 'function'
    ? scrollHeight
    : () => scrollHeight
  Object.defineProperties(element, {
    scrollTop: {
      configurable: true,
      get: () => Math.min(
        scrollTop,
        Math.max(0, currentScrollHeight() - clientHeight),
      ),
      set: (value: number) => { scrollTop = value },
    },
    scrollHeight: { configurable: true, get: currentScrollHeight },
    clientHeight: { configurable: true, get: () => clientHeight },
  })
  return () => element.scrollTop
}

function defineTop(element: HTMLElement, top: number): void {
  element.getBoundingClientRect = () => rectangle(top)
}

function defineRectangle(element: HTMLElement, top: number, height: number): void {
  element.getBoundingClientRect = () => rectangle(top, height)
}

function rectangle(top: number, height = 0): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: 0,
    width: 0,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }
}
