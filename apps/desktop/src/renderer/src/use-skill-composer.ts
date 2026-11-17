import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from 'react'
import {
  SKILL_MAX_SELECTIONS_PER_MESSAGE,
  type SkillCatalogSnapshot,
  type SkillSummary,
} from '@whycode/core/skills'
import {
  filterComposerItems,
  findSlashTrigger,
  removeSlashTrigger,
  type ComposerCommand,
  type ComposerCommandId,
  type ComposerMenuItem,
  type SlashTrigger,
} from './skill-trigger.ts'
import type { RuntimeWorkspace } from '../../shared/workspace.ts'
import type { ComposerInputHandle } from './composer-input.tsx'
import type { ComposerText } from './composer-text.ts'

const EMPTY_CATALOG: SkillCatalogSnapshot = {
  revision: '',
  skills: [],
  diagnostics: [],
  modelContext: null,
  omittedCount: 0,
}

interface UseSkillComposerOptions {
  input: ComposerText
  runtimeId: string
  runtimeIdRef: MutableRefObject<string>
  modelId: string
  projectDir: string | null
  workspaceMode: RuntimeWorkspace['mode']
  sshAvailability: 'loading' | 'connected' | 'offline'
  catalogVisible: boolean
  compactAvailable: boolean
  compactDisabled: boolean
  forkAvailable: boolean
  forkDisabled: boolean
  btwAvailable: boolean
  bbtwAvailable: boolean
  skillsEnabled: boolean
  onCommand: (command: ComposerCommandId) => void
}

/** Skill 目录和输入触发状态独立于附件草稿，App 只负责消息事务编排。 */
export function useSkillComposer(options: UseSkillComposerOptions) {
  const menuId = useId()
  const [catalog, setCatalog] = useState<SkillCatalogSnapshot>(EMPTY_CATALOG)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<SkillSummary[]>([])
  const [trigger, setTrigger] = useState<SlashTrigger | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const selectedRef = useRef<SkillSummary[]>([])
  const pendingCatalog = useRef<Promise<SkillCatalogSnapshot> | null>(null)
  const editorRef = useRef<ComposerInputHandle>(null)

  useEffect(() => {
    selectedRef.current = selected
  }, [selected])

  const selectedIds = useMemo(
    () => new Set(selected.map((skill) => skill.id)),
    [selected],
  )
  const commands = useMemo(
    () => createComposerCommands({
      compactAvailable: options.compactAvailable,
      compactDisabled: options.compactDisabled,
      forkAvailable: options.forkAvailable,
      forkDisabled: options.forkDisabled,
      btwAvailable: options.btwAvailable,
      bbtwAvailable: options.bbtwAvailable,
    }),
    [
      options.compactAvailable,
      options.compactDisabled,
      options.forkAvailable,
      options.forkDisabled,
      options.btwAvailable,
      options.bbtwAvailable,
    ],
  )
  const matches = useMemo(
    () => filterComposerItems(
      commands,
      options.skillsEnabled ? catalog.skills : [],
      selectedIds,
      trigger?.query ?? '',
    ),
    [catalog.skills, commands, options.skillsEnabled, selectedIds, trigger?.query],
  )
  const limitReached = selected.length >= SKILL_MAX_SELECTIONS_PER_MESSAGE

  useEffect(() => {
    if (!trigger || matches.length === 0) return
    setActiveIndex((current) => {
      if (current < matches.length && !menuItemDisabled(matches[current]!, limitReached)) {
        return current
      }
      const firstSelectable = matches.findIndex((item) => !menuItemDisabled(item, limitReached))
      return firstSelectable >= 0 ? firstSelectable : 0
    })
  }, [limitReached, matches, trigger])

  const resetCatalog = useCallback(() => {
    pendingCatalog.current = null
    setCatalog(EMPTY_CATALOG)
    setLoading(false)
  }, [])
  const refresh = useCallback(async () => {
    const target = options.runtimeId
    if (!target || pendingCatalog.current || (options.workspaceMode === 'ssh' && options.sshAvailability === 'loading')) return
    const request = window.whycode.listSkills(target)
    pendingCatalog.current = request
    const isCurrent = () => pendingCatalog.current === request && options.runtimeIdRef.current === target
    setLoading(true)
    try {
      const next = await request
      if (isCurrent()) setCatalog(next)
    } catch (error) {
      if (isCurrent()) setCatalog({ ...EMPTY_CATALOG, diagnostics: [{
        path: '', message: `Skill 目录读取失败：${error instanceof Error ? error.message : String(error)}`,
      }] })
    } finally {
      if (isCurrent()) { pendingCatalog.current = null; setLoading(false) }
    }
  }, [options.runtimeId, options.runtimeIdRef, options.workspaceMode, options.sshAvailability])
  useEffect(() => {
    resetCatalog()
    return () => { pendingCatalog.current = null }
  }, [refresh, options.projectDir, options.modelId, resetCatalog])

  const prefetch = options.workspaceMode !== 'ssh' || options.catalogVisible
  useEffect(() => {
    if (prefetch) void refresh()
  }, [prefetch, refresh, options.projectDir, options.modelId])
  const menuOpen = trigger !== null
  useEffect(() => {
    if (menuOpen) void refresh()
  }, [menuOpen, refresh, options.projectDir, options.modelId])

  const updateMenu = useCallback((text: string, cursor: number | null) => {
    setTrigger(findSlashTrigger(text, cursor))
    setActiveIndex(0)
  }, [])

  const replace = useCallback((skills: readonly SkillSummary[]) => {
    const next = skills.map((skill) => structuredClone(skill))
    selectedRef.current = next
    setSelected(next)
    setTrigger(null)
  }, [])

  const clear = useCallback(() => replace([]), [replace])
  const capture = useCallback(
    () => selectedRef.current.map((skill) => structuredClone(skill)),
    [],
  )

  const select = useCallback((item: ComposerMenuItem) => {
    if (!trigger) return
    if (item.kind === 'command' && item.command.disabled) return
    if (
      item.kind === 'skill'
      && (
        selectedRef.current.some((selectedSkill) => selectedSkill.id === item.skill.id)
        || selectedRef.current.length >= SKILL_MAX_SELECTIONS_PER_MESSAGE
      )
    ) return
    const replacement = removeSlashTrigger(options.input.getSnapshot(), trigger)
    options.input.set(replacement.text)
    if (item.kind === 'skill') {
      const next = [...selectedRef.current, structuredClone(item.skill)]
      selectedRef.current = next
      setSelected(next)
    }
    setTrigger(null)
    requestAnimationFrame(() => {
      const editor = editorRef.current
      if (!editor) return
      editor.focus()
      editor.setCursor(replacement.cursor)
    })
    if (item.kind === 'command') options.onCommand(item.command.id)
  }, [options.input, options.onCommand, trigger])

  const remove = useCallback((id: string) => {
    setSelected((current) => {
      const next = current.filter((skill) => skill.id !== id)
      selectedRef.current = next
      return next
    })
  }, [])

  const mergeRestored = useCallback((skills: readonly SkillSummary[]) => {
    setSelected((current) => {
      const known = new Set(current.map((skill) => skill.id))
      const next = [
        ...skills.filter((skill) => !known.has(skill.id)).map((skill) => structuredClone(skill)),
        ...current,
      ]
      selectedRef.current = next
      return next
    })
  }, [])

  const handlePickerKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.isComposing || !trigger) return false
    if (event.key === 'Escape') {
      event.preventDefault()
      setTrigger(null)
      return true
    }
    const selectableIndexes = matches
      .map((item, index) => menuItemDisabled(item, limitReached) ? -1 : index)
      .filter((index) => index >= 0)
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && selectableIndexes.length > 0) {
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      setActiveIndex((current) => {
        const currentPosition = selectableIndexes.indexOf(current)
        const origin = currentPosition >= 0 ? currentPosition : (delta > 0 ? -1 : 0)
        return selectableIndexes[(origin + delta + selectableIndexes.length) % selectableIndexes.length]!
      })
      return true
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && selectableIndexes.length > 0) {
      event.preventDefault()
      const selectedIndex = selectableIndexes.includes(activeIndex)
        ? activeIndex
        : selectableIndexes[0]!
      select(matches[selectedIndex]!)
      return true
    }
    return false
  }, [activeIndex, limitReached, matches, select, trigger])

  const closeMenu = useCallback(() => setTrigger(null), [])

  return {
    menuId,
    activeOptionId: trigger && matches[activeIndex] && !menuItemDisabled(matches[activeIndex]!, limitReached)
      ? `${menuId}-${activeIndex}` : undefined,
    catalog,
    loading,
    selected,
    trigger,
    matches,
    selectedIds,
    activeIndex,
    limitReached,
    editorRef,
    capture,
    clear,
    replace,
    mergeRestored,
    remove,
    select,
    resetCatalog,
    updateMenu,
    closeMenu,
    setActiveIndex,
    handlePickerKeyDown,
  }
}

export function createComposerCommands(
  options: {
    compactAvailable: boolean
    compactDisabled: boolean
    forkAvailable: boolean
    forkDisabled: boolean
    btwAvailable?: boolean
    bbtwAvailable?: boolean
  },
): ComposerCommand[] {
  const commands: ComposerCommand[] = [{
    id: 'mcp',
    name: 'MCP',
    description: '显示 MCP 服务器状态',
    keywords: ['mcp', '服务器', '连接', '状态'],
    disabled: false,
  }]
  if (options.btwAvailable) {
    commands.push({
      id: 'btw',
      name: 'BTW',
      description: '开始不写入主上下文的临时侧对话',
      keywords: ['btw', '临时', '侧对话'],
      disabled: false,
    })
  }
  if (options.bbtwAvailable) {
    commands.push({
      id: 'bbtw',
      name: 'BBTW',
      description: '续接刚才的临时侧对话，最多三轮',
      keywords: ['bbtw', '继续', '续接'],
      disabled: false,
    })
  }
  if (options.forkAvailable) {
    commands.push({
      id: 'fork',
      name: '在新对话中继续',
      description: '从最近一次完整模型回复创建独立对话',
      keywords: ['fork', 'branch', '分支'],
      disabled: options.forkDisabled,
    })
  }
  if (options.compactAvailable) {
    commands.push({
        id: 'compact',
        name: '压缩',
        description: '压缩当前会话上下文，释放上下文空间',
        keywords: ['compact', 'context'],
        disabled: options.compactDisabled,
      })
  }
  return commands
}

function menuItemDisabled(item: ComposerMenuItem, limitReached: boolean): boolean {
  return item.kind === 'command' ? item.command.disabled : limitReached
}
