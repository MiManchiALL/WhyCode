export interface ImageTransform { scale: number; x: number; y: number }
export interface ImageBounds { width: number; height: number; imageWidth: number; imageHeight: number }
export const IMAGE_ZOOM = { min: 1, max: 16, step: 1.25, dragThreshold: 4 } as const
export const FIT_IMAGE: ImageTransform = { scale: 1, x: 0, y: 0 }

export function constrainImage(view: ImageTransform, bounds: ImageBounds): ImageTransform {
  const scale = Math.max(IMAGE_ZOOM.min, Math.min(IMAGE_ZOOM.max, view.scale))
  const limitX = Math.max(0, (bounds.imageWidth * scale - bounds.width) / 2)
  const limitY = Math.max(0, (bounds.imageHeight * scale - bounds.height) / 2)
  return { scale, x: limitX ? Math.max(-limitX, Math.min(limitX, view.x)) : 0, y: limitY ? Math.max(-limitY, Math.min(limitY, view.y)) : 0 }
}

/** 锚点以画布中心为原点；限位之前，光标下的同一个像素保持不动。 */
export function zoomImage(view: ImageTransform, scale: number, point: { x: number; y: number }, bounds: ImageBounds): ImageTransform {
  const target = Math.max(IMAGE_ZOOM.min, Math.min(IMAGE_ZOOM.max, scale))
  const ratio = target / view.scale
  return constrainImage({ scale: target, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio }, bounds)
}

export function imageWheelDelta(delta: number, mode: number, height: number): number {
  return Math.max(-160, Math.min(160, delta * (mode === 1 ? 16 : mode === 2 ? height : 1)))
}
