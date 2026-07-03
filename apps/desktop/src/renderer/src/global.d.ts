import type { WhycodeApi } from '../../preload/index.ts'

declare global {
  interface Window {
    whycode: WhycodeApi
  }
}

export {}
