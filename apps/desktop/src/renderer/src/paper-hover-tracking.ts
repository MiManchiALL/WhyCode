const PAPER_CARD_SELECTOR = '.wc-paper-card:not(.wc-dialog-card)'
const POINTER_INSIDE_ATTRIBUTE = 'data-wc-pointer-inside'

function paperCardFromTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  return target.closest<HTMLElement>(PAPER_CARD_SELECTOR)
}

/**
 * Native IME windows can temporarily take Chromium's pointer hit without moving
 * the physical cursor. Keep the last in-document paper hit until the next real
 * document target proves that the cursor left the card.
 */
export function installPaperHoverTracking(document: Document): () => void {
  let activeCard: HTMLElement | null = null
  let pendingFrame: number | null = null
  const view = document.defaultView

  const setActiveCard = (nextCard: HTMLElement | null) => {
    if (activeCard === nextCard) return
    activeCard?.removeAttribute(POINTER_INSIDE_ATTRIBUTE)
    activeCard = nextCard
    activeCard?.setAttribute(POINTER_INSIDE_ATTRIBUTE, '')
  }

  const handlePointerOver = (event: PointerEvent) => {
    setActiveCard(paperCardFromTarget(event.target))
  }

  const handlePointerOut = (event: PointerEvent) => {
    if (event.relatedTarget === null) return
    setActiveCard(paperCardFromTarget(event.relatedTarget))
  }

  const handlePointerDown = (event: PointerEvent) => {
    setActiveCard(paperCardFromTarget(event.target))
    if (!view) return
    if (pendingFrame !== null) view.cancelAnimationFrame(pendingFrame)
    const { clientX, clientY } = event
    pendingFrame = view.requestAnimationFrame(() => {
      pendingFrame = null
      setActiveCard(paperCardFromTarget(document.elementFromPoint(clientX, clientY)))
    })
  }

  document.addEventListener('pointerover', handlePointerOver)
  document.addEventListener('pointerout', handlePointerOut)
  document.addEventListener('pointerdown', handlePointerDown, true)

  return () => {
    document.removeEventListener('pointerover', handlePointerOver)
    document.removeEventListener('pointerout', handlePointerOut)
    document.removeEventListener('pointerdown', handlePointerDown, true)
    if (pendingFrame !== null) view?.cancelAnimationFrame(pendingFrame)
    activeCard?.removeAttribute(POINTER_INSIDE_ATTRIBUTE)
  }
}
