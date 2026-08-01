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
  filterSkills,
  findSkillTrigger,
  removeSkillTrigger,
  type SkillTrigger,
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
}

/** Skill 目录和输入触发状态独立于附件草稿，App 只负责消息事务编排。 */
export function useSkillComposer(options: UseSkillComposerOptions) {
  const [catalog, setCatalog] = useState<SkillCatalogSnapshot>(EMPTY_CATALOG)
  const [selected, setSelected] = useState<SkillSummary[]>([])
  const [trigger, setTrigger] = useState<SkillTrigger | null>(null)
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
  const matches = useMemo(
    () => filterSkills(catalog.skills, trigger?.query ?? '')
      .filter((skill) => !selectedIds.has(skill.id)),
    [catalog.skills, selectedIds, trigger?.query],
  )

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
    setTrigger(findSkillTrigger(text, cursor))
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

  const select = useCallback((skill: SkillSummary) => {
    if (!trigger || selectedRef.current.some((item) => item.id === skill.id)) return
    if (selectedRef.current.length >= SKILL_MAX_SELECTIONS_PER_MESSAGE) return
    const replacement = removeSkillTrigger(options.input, trigger)
    const next = [...selectedRef.current, structuredClone(skill)]
    options.inputRef.current = replacement.text
    selectedRef.current = next
    options.setInput(replacement.text)
    setSelected(next)
    setTrigger(null)
    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.focus()
      textarea.setSelectionRange(replacement.cursor, replacement.cursor)
    })
  }, [options.input, options.inputRef, options.setInput, trigger])

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
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && matches.length > 0) {
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      setActiveIndex((current) => (current + delta + matches.length) % matches.length)
      return true
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && matches.length > 0) {
      event.preventDefault()
      select(matches[Math.min(activeIndex, matches.length - 1)]!)
      return true
    }
    return false
  }, [activeIndex, matches, select, trigger])

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
    limitReached: selected.length >= SKILL_MAX_SELECTIONS_PER_MESSAGE,
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
