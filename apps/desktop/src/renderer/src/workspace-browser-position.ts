import { restoredAnchorScrollTop, restoredScrollTop } from './conversation-presentation.ts'

export interface WorkspaceBrowserPosition {
  rootPath: string
  scrollTop: number
  anchor: { path: string; offset: number } | null
  directories: Record<string, number>
}

export function captureWorkspaceBrowserPosition(element: HTMLElement, rootPath: string): WorkspaceBrowserPosition {
  const top = element.getBoundingClientRect().top
  const anchor = [...element.querySelectorAll<HTMLElement>('[data-workspace-path]')]
    .find(row => row.getBoundingClientRect().bottom > top)
  return {
    rootPath,
    scrollTop: element.scrollTop,
    anchor: anchor ? {
      path: anchor.dataset.workspacePath!, offset: top - anchor.getBoundingClientRect().top,
    } : null,
    directories: Object.fromEntries([...element.querySelectorAll<HTMLElement>('[data-directory-path]')]
      .map(level => [level.dataset.directoryPath!, Number(level.dataset.directoryEntries)])),
  }
}

export function restoreWorkspaceBrowserPosition(element: HTMLElement, position: WorkspaceBrowserPosition): void {
  const rows = [...element.querySelectorAll<HTMLElement>('[data-workspace-path]')]
  let path = position.anchor?.path
  while (path) {
    const row = rows.find(candidate => candidate.dataset.workspacePath === path)
    if (row) {
      const top = element.scrollTop + row.getBoundingClientRect().top - element.getBoundingClientRect().top
      element.scrollTop = restoredAnchorScrollTop(top, path === position.anchor?.path ? position.anchor.offset : 0, element)
      return
    }
    path = path.slice(0, Math.max(0, path.lastIndexOf('/')))
  }
  element.scrollTop = restoredScrollTop({ atBottom: false, scrollTop: position.scrollTop }, element)
}
