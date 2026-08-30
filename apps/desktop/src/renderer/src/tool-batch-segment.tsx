import {
  Fragment,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { Block } from './conversation-state.ts'
import type { ToolBatch, ToolBatchSegment } from './conversation-tool-batches.ts'

export function ToolBatchSegmentView({
  segment,
  animateOnMount,
  renderBlock,
  renderBatch,
}: {
  segment: ToolBatchSegment
  animateOnMount: boolean
  renderBlock: (block: Block) => ReactNode
  renderBatch: (batch: ToolBatch) => ReactNode
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const sourceRef = useRef<HTMLDivElement>(null)
  const targetRef = useRef<HTMLDivElement>(null)
  const animationsRef = useRef<Animation[]>([])
  const [displaySealed, setDisplaySealed] = useState(
    () => segment.sealed && !animateOnMount,
  )

  useLayoutEffect(() => {
    if (!segment.sealed) {
      cancelAnimations(animationsRef)
      if (displaySealed) setDisplaySealed(false)
      return
    }
    if (displaySealed) return

    const container = containerRef.current
    const source = sourceRef.current
    const target = targetRef.current
    if (!container || !source || !target) {
      setDisplaySealed(true)
      return
    }
    if (
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
      || typeof container.animate !== 'function'
    ) {
      setDisplaySealed(true)
      return
    }

    const fromHeight = source.getBoundingClientRect().height
    const toHeight = target.getBoundingClientRect().height
    container.style.height = `${fromHeight}px`
    container.style.overflow = 'hidden'
    container.style.pointerEvents = 'none'

    const heightAnimation = container.animate([
      { height: `${fromHeight}px` },
      { height: `${toHeight}px` },
    ], {
      duration: 150,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      fill: 'forwards',
    })
    const sourceAnimation = source.animate([
      { opacity: 1, transform: 'translateY(0)' },
      { opacity: 0.55, transform: 'translateY(-0.15rem)' },
    ], {
      duration: 125,
      easing: 'ease-out',
      fill: 'forwards',
    })
    animationsRef.current = [heightAnimation, sourceAnimation]
    heightAnimation.onfinish = () => setDisplaySealed(true)

    return () => cancelAnimations(animationsRef)
  }, [displaySealed, segment.id, segment.sealed])

  if (!segment.sealed || displaySealed) {
    return (
      <ToolSegmentContent
        segment={segment}
        sealed={segment.sealed}
        renderBlock={renderBlock}
        renderBatch={renderBatch}
      />
    )
  }

  return (
    <div ref={containerRef} className="relative flow-root" data-tool-segment-transition="">
      <div ref={sourceRef} className="flow-root">
        <ToolSegmentContent
          segment={segment}
          sealed={false}
          renderBlock={renderBlock}
          renderBatch={renderBatch}
        />
      </div>
      <div
        ref={targetRef}
        className="pointer-events-none absolute inset-x-0 top-0 flow-root"
        style={{ visibility: 'hidden' }}
        aria-hidden="true"
        inert
      >
        <ToolSegmentContent
          segment={segment}
          sealed
          renderBlock={renderBlock}
          renderBatch={renderBatch}
        />
      </div>
    </div>
  )
}

function ToolSegmentContent({
  segment,
  sealed,
  renderBlock,
  renderBatch,
}: {
  segment: ToolBatchSegment
  sealed: boolean
  renderBlock: (block: Block) => ReactNode
  renderBatch: (batch: ToolBatch) => ReactNode
}) {
  if (!sealed) {
    return segment.blocks.map((block) => (
      <Fragment key={block.id}>{renderBlock(block)}</Fragment>
    ))
  }

  let renderedBatch = false
  return segment.blocks.map((block) => {
    if (block.kind !== 'tool') {
      return <Fragment key={block.id}>{renderBlock(block)}</Fragment>
    }
    if (renderedBatch) return null
    renderedBatch = true
    return <Fragment key={segment.batch.id}>{renderBatch(segment.batch)}</Fragment>
  })
}

function cancelAnimations(ref: { current: Animation[] }): void {
  for (const animation of ref.current) animation.cancel()
  ref.current = []
}
