/// <reference types="vite/client" />
import { webFrame } from 'electron'
import { createScrollbarActivity } from '../shared/scrollbar-activity.ts'
import scrollbarStyles from '../shared/scrollbars.css?inline'

// 仅提供滚动条外观；不向网页暴露 Node、IPC 或任何宿主能力。
void webFrame.insertCSS(scrollbarStyles, { cssOrigin: 'user' })
const scrollbars = createScrollbarActivity(document)
window.addEventListener('unload', () => scrollbars.dispose(), { once: true })
