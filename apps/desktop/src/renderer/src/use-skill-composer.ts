import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type MutableRefObject,
  type SetStateAction,
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

const EMPTY_CATALOG: SkillCatalogSnapshot = {
  revision: '',
  skills: [],
  diagnostics: [],
  modelContext: null,
  omittedCount: 0,
}

interface UseSkillComposerOptions {
  input: string
  setInput: Dispatch<SetStateAction<string>>
  inputRef: MutableRefObject<string>
  runtimeId: string
  runtimeIdRef: MutableRefObject<string>
  modelId: string
  projectDir: string | null
  workspaceMode: RuntimeWorkspace['mode']
  compactAvailable: boolean
  compactDisabled: boolean
  onCommand: (command: ComposerCommandId) => void
}

/** Skill 目录和输入触发状态独立于附件草稿，App 只负责消息事务编排。 */
export function useSkillComposer(options: UseSkillComposerOptions) {
  const [catalog, setCatalog] = useState<SkillCatalogSnapshot>(EMPTY_CATALOG)
  const [selected, setSelected] = useState<SkillSummary[]>([])
  const [trigger, setTrigger] = useState<SlashTrigger | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const selectedRef = useRef<SkillSummary[]>([])
  const refreshSequenceRef = useRef(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    selectedRef.current = selected
  }, [selected])

  const selectedIds = useMemo(
    () => new Set(selected.map((skill) => skill.id)),
    [selected],
  )
  const commands = useMemo(
    () => createComposerCommands(options.compactAvailable, options.compactDisabled),
    [options.compactAvailable, options.compactDisabled],
  )
  const matches = useMemo(
    () => filterComposerItems(
      commands,
      catalog.skills,
      selectedIds,
      trigger?.query ?? '',
    ),
    [catalog.skills, commands, selectedIds, trigger?.query],
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

  const refresh = useCallback(async () => {
    const targetRuntimeId = options.runtimeIdRef.current
    if (!targetRuntimeId) return
    const sequence = ++refreshSequenceRef.current
    try {
      const next = await window.whycode.listSkills(targetRuntimeId)
      if (
        options.runtimeIdRef.current === targetRuntimeId
        && refreshSequenceRef.current === sequence
      ) setCatalog(next)
    } catch (error) {
      if (
        options.runtimeIdRef.current !== targetRuntimeId
        || refreshSequenceRef.current !== sequence
      ) return
      setCatalog({
        ...EMPTY_CATALOG,
        diagnostics: [{
          path: '',
          message: `Skill 目录读取失败：${error instanceof Error ? error.message : String(error)}`,
        }],
      })
    }
  }, [options.runtimeIdRef])

  useEffect(() => {
    if (options.runtimeId) void refresh()
  }, [
    options.modelId,
    options.projectDir,
    options.runtimeId,
    options.workspaceMode,
    refresh,
  ])

  const menuOpen = trigger !== null
  useEffect(() => {
    if (menuOpen) void refresh()
  }, [menuOpen, refresh])

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
    const replacement = removeSlashTrigger(options.input, trigger)
    options.inputRef.current = replacement.text
    options.setInput(replacement.text)
    if (item.kind === 'skill') {
      const next = [...selectedRef.current, structuredClone(item.skill)]
      selectedRef.current = next
      setSelected(next)
    }
    setTrigger(null)
    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.focus()
      textarea.setSelectionRange(replacement.cursor, replacement.cursor)
    })
    if (item.kind === 'command') options.onCommand(item.command.id)
  }, [options.input, options.inputRef, options.onCommand, options.setInput, trigger])

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

  const handlePickerKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || !trigger) return false
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

  const resetCatalog = useCallback(() => {
    refreshSequenceRef.current++
    setCatalog(EMPTY_CATALOG)
  }, [])
  const closeMenu = useCallback(() => setTrigger(null), [])

  return {
    catalog,
    selected,
    trigger,
    matches,
    selectedIds,
    activeIndex,
    limitReached,
    textareaRef,
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
  compactAvailable: boolean,
  compactDisabled: boolean,
): ComposerCommand[] {
  return compactAvailable
    ? [{
        id: 'compact',
        name: '压缩',
        description: '压缩当前会话上下文，释放上下文空间',
        keywords: ['compact', 'context'],
        disabled: compactDisabled,
      }]
    : []
}

function menuItemDisabled(item: ComposerMenuItem, limitReached: boolean): boolean {
  return item.kind === 'command' ? item.command.disabled : limitReached
}
