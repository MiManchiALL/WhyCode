import {
  BrowserWindow,
  desktopCapturer,
  screen,
  type Display,
  type NativeImage,
} from 'electron'
import type {
  ScreenshotCaptureRequest,
  ScreenshotCaptureResult,
} from '@whycode/core'
import {
  fitImageSize,
  regionCrop,
  selectDisplaySource,
  selectWindowSource,
} from './screenshot-selection.ts'

const MAX_CAPTURE_DIMENSION = 7_680
const MAX_CAPTURE_PIXELS = 20_000_000
const MAX_CAPTURE_BYTES = 20_000_000

export async function captureDesktopScreenshot(
  request: ScreenshotCaptureRequest,
  abortSignal: AbortSignal,
): Promise<ScreenshotCaptureResult> {
  throwIfAborted(abortSignal)
  if (request.target === 'window') return captureWindow(request, abortSignal)
  return captureDisplay(request, abortSignal)
}

async function captureDisplay(
  request: ScreenshotCaptureRequest,
  abortSignal: AbortSignal,
): Promise<ScreenshotCaptureResult> {
  const display = selectDisplay(request.display_id)
  const physicalSize = fitImageSize({
    width: Math.max(1, Math.round(display.bounds.width * display.scaleFactor)),
    height: Math.max(1, Math.round(display.bounds.height * display.scaleFactor)),
  }, MAX_CAPTURE_DIMENSION, MAX_CAPTURE_PIXELS)
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: physicalSize,
  })
  throwIfAborted(abortSignal)
  const source = selectDisplaySource(sources, String(display.id))
  let image = source.thumbnail
  if (image.isEmpty()) throw new Error('系统没有返回屏幕画面；请检查操作系统的屏幕录制权限')

  let description = `已截取显示器 ${display.id}${display.label ? `（${display.label}）` : ''}`
  if (request.target === 'region') {
    const region = request.region!
    const crop = regionCrop(region, display.bounds, image.getSize())
    image = image.crop(crop)
    description += ` 的区域 DIP(${formatRegion(region)})`
  }
  const encoded = encodeBoundedPng(image)
  if (encoded.resized) description += '；为满足 20 MB 附件上限已等比缩小'
  return {
    name: screenshotName(request.target),
    bytes: encoded.bytes,
    description,
  }
}

async function captureWindow(
  request: ScreenshotCaptureRequest,
  abortSignal: AbortSignal,
): Promise<ScreenshotCaptureResult> {
  const lightweight = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 0, height: 0 },
  })
  const selected = selectWindowSource(
    lightweight,
    request.window_title,
    currentWhyCodeWindow()?.getMediaSourceId(),
  )
  throwIfAborted(abortSignal)
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: MAX_CAPTURE_DIMENSION, height: MAX_CAPTURE_DIMENSION },
  })
  throwIfAborted(abortSignal)
  const source = sources.find((candidate) => candidate.id === selected.id)
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error('系统没有返回所选窗口画面；窗口可能已关闭、最小化或缺少屏幕录制权限')
  }
  const encoded = encodeBoundedPng(source.thumbnail)
  return {
    name: screenshotName('window'),
    bytes: encoded.bytes,
    description: `已截取窗口「${source.name}」${encoded.resized ? '；为满足 20 MB 附件上限已等比缩小' : ''}`,
  }
}

function selectDisplay(displayId: string | undefined): Display {
  const displays = screen.getAllDisplays()
  const selected = displayId
    ? displays.find((display) => String(display.id) === displayId)
    : screen.getPrimaryDisplay()
  if (selected) return selected
  throw new Error(
    `找不到显示器 ${displayId}；可用显示器：${displays.map((display) =>
      `${display.id}${display.label ? `(${display.label})` : ''}`).join('、')}`,
  )
}

function currentWhyCodeWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow()
    ?? BrowserWindow.getAllWindows().find((window) => !window.isDestroyed())
    ?? null
}

function encodeBoundedPng(source: NativeImage): { bytes: Buffer; resized: boolean } {
  const sourceSize = source.getSize()
  const boundedSize = fitImageSize(
    sourceSize,
    MAX_CAPTURE_DIMENSION,
    MAX_CAPTURE_PIXELS,
  )
  let image = boundedSize.width === sourceSize.width && boundedSize.height === sourceSize.height
    ? source
    : source.resize({ ...boundedSize, quality: 'best' })
  let resized = image !== source
  for (let attempt = 0; attempt < 6; attempt++) {
    const bytes = image.toPNG()
    if (bytes.byteLength <= MAX_CAPTURE_BYTES) {
      return { bytes, resized }
    }
    const size = image.getSize()
    const ratio = Math.sqrt(MAX_CAPTURE_BYTES / bytes.byteLength) * 0.9
    const width = Math.max(1, Math.floor(size.width * Math.min(0.85, ratio)))
    const height = Math.max(1, Math.floor(size.height * Math.min(0.85, ratio)))
    if (width >= size.width || height >= size.height) break
    image = image.resize({ width, height, quality: 'best' })
    resized = true
  }
  throw new Error('截图压缩后仍超过 20 MB，请改用区域截图')
}

function screenshotName(target: ScreenshotCaptureRequest['target']): string {
  return `screenshot-${target}-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.png`
}

function formatRegion(region: { x: number; y: number; width: number; height: number }): string {
  return `${region.x},${region.y},${region.width},${region.height}`
}

function throwIfAborted(abortSignal: AbortSignal): void {
  if (abortSignal.aborted) throw new Error('截图已取消')
}
