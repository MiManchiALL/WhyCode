import type { BrowserRect, BrowserReferenceSource, BrowserTarget } from '@whycode/core/browser-reference'

export interface BrowserPickOptions {
  selected: BrowserTarget[]
  parent?: boolean
}
export interface BrowserTargetCapture {
  target: BrowserTarget
  page: BrowserReferenceSource['page']
  bytes: Uint8Array
  crop: BrowserRect
  continuePicking: boolean
}
export interface BrowserReferenceImage {
  bytes: Uint8Array
  source: BrowserReferenceSource
}
