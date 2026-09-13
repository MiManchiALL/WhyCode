import { Menu, type BrowserWindow } from 'electron'

export function installImageContextMenu(window: BrowserWindow): void {
  const contents = window.webContents
  contents.on('context-menu', (_event, { mediaType, hasImageContents, x, y }) => {
    if (mediaType !== 'image' || !hasImageContents) return
    Menu.buildFromTemplate([{
      label: '复制图片',
      click: () => contents.copyImageAt(x, y),
    }]).popup({ window })
  })
}
