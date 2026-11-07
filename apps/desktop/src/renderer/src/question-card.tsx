import { useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, MessageCircleQuestionMark, Pencil, X } from 'lucide-react'
import type { PendingQuestion, QuestionResolution } from '@whycode/core/events'
import type { ComposerValue } from './composer-text.ts'
import type { QuestionDraft } from './composer-drafts.ts'

interface QuestionCardProps {
  questions: readonly PendingQuestion[]
  input: ComposerValue<QuestionDraft | undefined>
  disabled: boolean
  stopControl?: ReactNode
  onResolve: (resolution: QuestionResolution) => Promise<void>
}

export function QuestionCard({ questions, input, disabled, stopControl, onResolve }: QuestionCardProps) {
  const draft = useSyncExternalStore(input.subscribe, input.getSnapshot)
  const [submitting, setSubmitting] = useState(false)
  const sending = useRef(false)
  const index = Math.max(0, questions.findIndex(item => item.id === draft?.currentId))
  const question = questions[index]
  if (!question) return null
  const answers = draft?.answers ?? {}
  const text = answers[question.id] ?? ''
  const select = (id: string) => input.replace({ answers, currentId: id })
  const edit = (answer: string) => input.replace({ currentId: question.id, answers: { ...answers, [question.id]: answer } })
  const blocked = disabled || submitting
  const resolve = async (answer: string | null) => {
    if (blocked || sending.current) return
    sending.current = true
    setSubmitting(true)
    try { await onResolve({ id: question.id, answer }) }
    finally { sending.current = false; setSubmitting(false) }
  }
  if (draft?.collapsed) return (
    <button type="button" className="wc-question-summary wc-focus-ring" onClick={() => select(question.id)}>
      <MessageCircleQuestionMark size={15} />{questions.length} 个待答问题
    </button>
  )
  return <form className="wc-question-composer" onSubmit={event => {
    event.preventDefault()
    if (text.trim()) void resolve(text.trim())
  }}>
    <div className="wc-question-heading">
      <MessageCircleQuestionMark size={15} /><span className="min-w-0 flex-1 truncate">{question.item.header}</span>
      {questions.length > 1 && <>
        <button type="button" className="wc-icon-button" aria-label="上一题" disabled={index === 0 || submitting}
          onClick={() => select(questions[index - 1]!.id)}><ChevronLeft size={14} /></button>
        <span className="tabular-nums">{index + 1} / {questions.length}</span>
        <button type="button" className="wc-icon-button" aria-label="下一题" disabled={index + 1 === questions.length || submitting}
          onClick={() => select(questions[index + 1]!.id)}><ChevronRight size={14} /></button>
      </>}
      <button type="button" className="wc-icon-button" aria-label="收起待答问题" title="收起待答问题"
        onClick={() => input.replace({ currentId: question.id, answers, collapsed: true })}><X size={14} /></button>
    </div>
    <div className="wc-question-title">{question.item.question}</div>
    {question.item.options?.length && <div className="wc-question-options">
      {question.item.options.map((option, i) => <button key={i} type="button" className="wc-question-option wc-focus-ring"
        aria-pressed={text === option.label} disabled={blocked} onClick={() => edit(option.label)}>
        <span className="wc-question-option-index" aria-hidden="true">{i + 1}</span>
        <span><span className="block font-medium">{option.label}</span>
          {option.description && <span className="wc-question-description">{option.description}</span>}</span>
      </button>)}
    </div>}
    <div className="wc-question-controls">
      <label className="wc-question-field"><Pencil size={14} />
        <input aria-label="当前问题的回答" placeholder="写下你的回答…" value={text} disabled={blocked}
          onChange={event => edit(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault() }} />
      </label>
      {stopControl}
      <button type="button" className="wc-settings-button wc-focus-ring" disabled={blocked}
        onClick={() => void resolve(null)}>跳过</button>
      <button type="submit" className="wc-settings-button wc-focus-ring" data-variant="primary" disabled={blocked || !text.trim()}>发送</button>
    </div>
  </form>
}
