import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Maximize, Minus, Plus } from 'lucide-react'
import { constrainImage, FIT_IMAGE, IMAGE_ZOOM, imageWheelDelta, zoomImage, type ImageTransform } from './image-transform.ts'

export function ImageViewport({ src, name }: { src: string; name: string }) {
  const viewport = useRef<HTMLDivElement>(null)
  const image = useRef<HTMLImageElement>(null)
  const [view, setView] = useState(FIT_IMAGE)
  const [imageState, setImageState] = useState<'loading' | 'ready' | 'error'>('loading')
  const loaded = imageState === 'ready'
  const drag = useRef<{ pointerId: number; startX: number; startY: number; view: ImageTransform; moved: boolean } | null>(null)
  const frame = useRef<number | null>(null)
  const bounds = useCallback(() => ({ width: viewport.current?.clientWidth ?? 0, height: viewport.current?.clientHeight ?? 0,
    imageWidth: image.current?.clientWidth ?? 0, imageHeight: image.current?.clientHeight ?? 0 }), [])
  const stopDrag = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    const pointerId = drag.current?.pointerId
    drag.current = null
    if (viewport.current) {
      delete viewport.current.dataset.dragging
      if (pointerId !== undefined && viewport.current.hasPointerCapture(pointerId)) viewport.current.releasePointerCapture(pointerId)
    }
  }, [])
  const zoom = useCallback((factor: number, client?: { x: number; y: number }) => {
    stopDrag()
    const box = viewport.current?.getBoundingClientRect()
    const point = client && box ? { x: client.x - box.left - box.width / 2, y: client.y - box.top - box.height / 2 } : { x: 0, y: 0 }
    setView(current => zoomImage(current, current.scale * factor, point, bounds()))
  }, [bounds, stopDrag])
  const reset = () => { stopDrag(); setView(FIT_IMAGE) }

  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) return
    const resize = new ResizeObserver(() => {
      stopDrag()
      setView(current => {
        const next = constrainImage(current, bounds())
        return next.x === current.x && next.y === current.y ? current : next
      })
    })
    resize.observe(element)
    return () => resize.disconnect()
  }, [bounds, stopDrag])
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      if (!loaded || event.deltaY === 0) return
      zoom(Math.exp(-imageWheelDelta(event.deltaY, event.deltaMode, element.clientHeight) * .005), { x: event.clientX, y: event.clientY })
    }
    element.addEventListener('wheel', wheel, { passive: false })
    window.addEventListener('blur', stopDrag)
    return () => {
      element.removeEventListener('wheel', wheel)
      window.removeEventListener('blur', stopDrag)
      stopDrag()
    }
  }, [loaded, zoom, stopDrag])

  const pan = (clientX: number, clientY: number) => {
    const current = drag.current
    if (!current) return
    const dx = clientX - current.startX, dy = clientY - current.startY
    current.moved ||= Math.hypot(dx, dy) >= IMAGE_ZOOM.dragThreshold
    if (!current.moved) return
    if (viewport.current) viewport.current.dataset.dragging = 'true'
    setView(constrainImage({ ...current.view, x: current.view.x + dx, y: current.view.y + dy }, bounds()))
  }
  return <>
    <div ref={viewport} className="wc-image-viewport" tabIndex={0} role="region" aria-label="图片画布"
      aria-busy={imageState === 'loading'} data-zoomed={view.scale > 1 || undefined}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || !loaded) return
        if (!['+', '=', '-', '0'].includes(event.key)) return
        event.preventDefault()
        if (event.key === '0') reset()
        else zoom(event.key === '-' ? 1 / IMAGE_ZOOM.step : IMAGE_ZOOM.step)
      }}
      onDoubleClick={event => {
        if (!loaded) return
        if (view.scale > 1) reset()
        else zoom(2, { x: event.clientX, y: event.clientY })
      }}
      onPointerDown={event => {
        if (event.button !== 0 || !event.isPrimary || view.scale <= 1 || !loaded) return
        stopDrag()
        event.currentTarget.focus({ preventScroll: true })
        drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, view, moved: false }
        event.currentTarget.setPointerCapture(event.pointerId)
        event.preventDefault()
      }}
      onPointerMove={event => {
        if (drag.current?.pointerId !== event.pointerId) return
        if (frame.current !== null) cancelAnimationFrame(frame.current)
        const { clientX, clientY } = event
        frame.current = requestAnimationFrame(() => { frame.current = null; pan(clientX, clientY) })
      }}
      onPointerUp={event => {
        if (drag.current?.pointerId !== event.pointerId) return
        pan(event.clientX, event.clientY)
        stopDrag()
      }}
      onPointerCancel={stopDrag} onLostPointerCapture={stopDrag}>
      {!loaded && <p role="status" className="absolute text-sm text-neutral-400">{imageState === 'error' ? '图片加载失败' : '正在加载图片…'}</p>}
      <img ref={image} src={src} alt={name} draggable={false} decoding="async"
        className="max-h-[calc(92vh-9rem)] max-w-full object-contain"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, opacity: loaded ? 1 : 0 }}
        onLoad={() => setImageState('ready')} onError={() => setImageState('error')} />
    </div>
    <div className="wc-image-controls">
      <button type="button" className="wc-image-action" aria-label="缩小图片" title="缩小（−）" disabled={!loaded || view.scale <= IMAGE_ZOOM.min} onClick={() => zoom(1 / IMAGE_ZOOM.step)}><Minus size={16} /></button>
      <output className="min-w-12 text-center text-xs tabular-nums" aria-label="相对适应窗口的缩放比例">{Math.round(view.scale * 100)}%</output>
      <button type="button" className="wc-image-action" aria-label="放大图片" title="放大（+）" disabled={!loaded || view.scale >= IMAGE_ZOOM.max} onClick={() => zoom(IMAGE_ZOOM.step)}><Plus size={16} /></button>
      <button type="button" className="wc-image-action ml-2" aria-label="适应窗口" title="适应窗口（0），双击图片也可复位" disabled={!loaded} onClick={reset}><Maximize size={16} /></button>
    </div>
  </>
}
