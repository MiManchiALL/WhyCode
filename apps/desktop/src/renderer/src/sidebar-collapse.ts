import { useCallback, useState } from 'react'
import type { SidebarProject } from '../../shared/projects.ts'

const STORAGE_PREFIX = 'whycode:sidebar-collapsed:'
const PROJECT_PREFIX = `${STORAGE_PREFIX}project:`

export function useSidebarGroupCollapsed(group: 'pinned' | 'projects' | `project:${string}`) {
  const key = `${STORAGE_PREFIX}${group}`
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return globalThis.localStorage.getItem(key) === 'true'
    } catch {
      return false
    }
  })
  const update = useCallback((value: boolean) => {
    setCollapsed(value)
    try {
      if (value) globalThis.localStorage.setItem(key, 'true')
      else globalThis.localStorage.removeItem(key)
    } catch {
      // 存储不可用时，分组仍可在当前界面开合。
    }
  }, [key])
  return [collapsed, update] as const
}

export function pruneSidebarProjectCollapse(projects: readonly SidebarProject[]): void {
  try {
    const storage = globalThis.localStorage
    const retained = new Set(projects.map(project => `${PROJECT_PREFIX}${project.id}`))
    for (let index = storage.length - 1; index >= 0; index--) {
      const key = storage.key(index)
      if (key?.startsWith(PROJECT_PREFIX) && !retained.has(key)) storage.removeItem(key)
    }
  } catch {
    // 界面偏好的清理失败不影响项目快照的展示。
  }
}
