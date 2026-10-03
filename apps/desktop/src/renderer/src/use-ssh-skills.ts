import { useCallback, useEffect, useRef, useState } from 'react'
import type { SshConnectionInput, SshRequest } from '../../shared/ssh.ts'
import type { SshSkillJob, SshSkillListing } from '../../shared/ssh-skills.ts'
import { useConversationFeedback } from './conversation-feedback.tsx'

export function useSshSkills(id: string) {
  const [listing, setListing] = useState<SshSkillListing | null>(null)
  const [job, setJob] = useState<SshSkillJob | undefined>()
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [credentials, updateCredentials] = useState<SshRequest | null>(null)
  const pendingCredentials = useRef<SshRequest | null>(null)
  const sending = useRef(false)
  const mounted = useRef(true)
  const sequence = useRef(0)
  const statusSequence = useRef(0)
  const active = useRef(false)
  const feedback = useConversationFeedback()
  const setCredentials = useCallback((request: SshRequest | null) => {
    pendingCredentials.current = request; updateCredentials(request)
  }, [])

  const load = useCallback(async () => {
    if (sending.current || pendingCredentials.current) return
    const current = ++sequence.current
    setLoading(true); setError(null)
    const request: SshRequest = { action: 'skills-list', id }
    try {
      const result = await window.whycode.ssh(request)
      if (!mounted.current || current !== sequence.current) return
      if (!result.ok) {
        if (result.credentialsRequired) setCredentials(request)
        throw new Error(result.error)
      }
      setListing(result.skills ?? null)
    } catch (failure) { if (mounted.current && current === sequence.current) setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { if (mounted.current && current === sequence.current) setLoading(false) }
  }, [id, setCredentials])

  useEffect(() => {
    mounted.current = true
    const status = async (refresh = false) => {
      const current = ++statusSequence.current
      try {
        const result = await window.whycode.ssh({ action: 'skills-status', id })
        if (!mounted.current || current !== statusSequence.current) return
        if (!result.ok) throw new Error(result.error)
        const finished = active.current && !result.skillJob?.running
        active.current = result.skillJob?.running ?? false
        setJob(result.skillJob)
        if (!active.current && (refresh || finished)) void load()
        else if (active.current) setLoading(false)
      } catch (failure) { if (mounted.current) { setError(String(failure)); setLoading(false) } }
    }
    void status(true)
    const unsubscribe = window.whycode.onSshSkillsChanged(() => { void status() })
    return () => { mounted.current = false; sequence.current++; statusSequence.current++; unsubscribe() }
  }, [id, load])

  const run = async (request: SshRequest) => {
    if (active.current || sending.current) return
    active.current = true; sending.current = true; setSubmitting(true); setError(null)
    // 读取中的旧目录快照不能覆盖这次写操作的结果。
    sequence.current++; setLoading(false)
    try {
      const result = await window.whycode.ssh(request)
      if (!result.ok) {
        if (mounted.current && result.credentialsRequired) setCredentials(request)
        throw new Error(result.error)
      }
      const failures = result.skillJob?.results.filter(item => !item.ok) ?? []
      const count = result.skillJob?.results.length ?? 0
      feedback(failures.length ? 'error' : 'success', failures.length ? `${count - failures.length} 项已完成，${failures.length} 项失败；可返回 Skill 管理查看并重试` : `${request.action === 'skills-clean' ? '已清理' : '已同步'} ${count} 个 Skill`, true)
      if (mounted.current) setJob(result.skillJob)
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure)
      feedback('error', message, true)
      if (mounted.current) setError(message)
    } finally {
      active.current = false; sending.current = false
      if (mounted.current) { setSubmitting(false); void load() }
    }
  }
  const saveCredentials = async (connection: SshConnectionInput) => {
    const result = await window.whycode.ssh({ action: 'save', connection })
    if (!result.ok) { feedback('error', result.error, true); return }
    const request = credentials
    setCredentials(null)
    if (request?.action === 'skills-list') void load()
    else if (request) void run(request)
  }
  return { listing, job, loading, busy: submitting || Boolean(job?.running), error, credentials, setCredentials, saveCredentials, run, load }
}
