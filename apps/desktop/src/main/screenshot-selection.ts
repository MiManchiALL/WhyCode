export interface ScreenshotSourceLike {
  id: string
  name: string
  display_id: string
}

export function selectDisplaySource<T extends ScreenshotSourceLike>(
  sources: readonly T[],
  displayId: string,
): T {
  const selected = sources.find((source) => source.display_id === displayId)
    ?? (sources.length === 1 ? sources[0] : undefined)
  if (selected) return selected
  throw new Error(`系统返回的屏幕源中没有显示器 ${displayId}`)
}

export function selectWindowSource<T extends ScreenshotSourceLike>(
  sources: readonly T[],
  windowTitle: string | undefined,
  currentSourceId?: string,
): T {
  if (!windowTitle) {
    const current = currentSourceId
      ? sources.find((source) => source.id === currentSourceId)
      : undefined
    if (current) return current
    throw new Error('找不到当前 WhyCode 窗口；请提供 window_title 选择其它窗口')
  }
  const wanted = windowTitle.trim().toLocaleLowerCase()
  if (!wanted) throw new Error('窗口标题不能为空')
  const exact = sources.filter((source) => source.name.toLocaleLowerCase() === wanted)
  if (exact.length === 1) return exact[0]!
  const partial = sources.filter((source) => source.name.toLocaleLowerCase().includes(wanted))
  if (partial.length === 1) return partial[0]!
  if (exact.length > 1 || partial.length > 1) {
    throw new Error(`窗口标题不唯一：${(exact.length ? exact : partial).map((source) => source.name).join('、')}`)
  }
  const available = sources.slice(0, 8).map((source) => source.name).filter(Boolean)
  throw new Error(`找不到窗口「${windowTitle}」${available.length ? `；可见窗口：${available.join('、')}` : ''}`)
}

export function regionCrop(
  region: { x: number; y: number; width: number; height: number },
  displaySize: { width: number; height: number },
  imageSize: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  if (
    !Number.isFinite(region.x)
    || !Number.isFinite(region.y)
    || !Number.isFinite(region.width)
    || !Number.isFinite(region.height)
    || region.x < 0
    || region.y < 0
    || region.width <= 0
    || region.height <= 0
  ) {
    throw new Error('截图区域必须是显示器内的非负坐标和正尺寸')
  }
  if (
    !Number.isFinite(displaySize.width)
    || !Number.isFinite(displaySize.height)
    || !Number.isFinite(imageSize.width)
    || !Number.isFinite(imageSize.height)
    || displaySize.width <= 0
    || displaySize.height <= 0
    || imageSize.width <= 0
    || imageSize.height <= 0
  ) {
    throw new Error('显示器或截图尺寸无效')
  }
  if (
    region.x + region.width > displaySize.width
    || region.y + region.height > displaySize.height
  ) {
    throw new Error(`截图区域超出显示器 DIP 边界 ${displaySize.width}×${displaySize.height}`)
  }
  const scaleX = imageSize.width / displaySize.width
  const scaleY = imageSize.height / displaySize.height
  const crop = {
    x: Math.round(region.x * scaleX),
    y: Math.round(region.y * scaleY),
    width: Math.max(1, Math.round(region.width * scaleX)),
    height: Math.max(1, Math.round(region.height * scaleY)),
  }
  crop.width = Math.min(crop.width, imageSize.width - crop.x)
  crop.height = Math.min(crop.height, imageSize.height - crop.y)
  if (crop.width <= 0 || crop.height <= 0) throw new Error('截图区域为空')
  return crop
}

/** 截图在进入 Core 解码器前先满足统一的尺寸/像素边界，保持宽高比。 */
export function fitImageSize(
  size: { width: number; height: number },
  maxDimension: number,
  maxPixels: number,
): { width: number; height: number } {
  if (
    !Number.isFinite(size.width)
    || !Number.isFinite(size.height)
    || size.width <= 0
    || size.height <= 0
    || !Number.isFinite(maxDimension)
    || !Number.isFinite(maxPixels)
    || maxDimension <= 0
    || maxPixels <= 0
  ) throw new Error('截图尺寸边界无效')
  const ratio = Math.min(
    1,
    maxDimension / Math.max(size.width, size.height),
    Math.sqrt(maxPixels / (size.width * size.height)),
  )
  return {
    width: Math.max(1, Math.floor(size.width * ratio)),
    height: Math.max(1, Math.floor(size.height * ratio)),
  }
}
