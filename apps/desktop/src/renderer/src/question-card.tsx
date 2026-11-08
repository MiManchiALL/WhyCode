import { useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, MessageCircleQuestionMark, Pencil, X } from 'lucide-react'
import type { PendingQuestion, QuestionSubmission } from '@whycode/core/events'
import { composerKeyAction } from './composer-key.ts'
import type { ComposerValue } from './composer-text.ts'
import { questionSubmission } from './question-progress.ts'
import type { QuestionDraft } from './composer-drafts.ts'

interface QuestionCardProps {
  questions: readonly PendingQuestion[]
  input: ComposerValue<QuestionDraft | undefined>
  disabled: boolean
  stopControl?: ReactNode
  onResolve: (resolutions: QuestionSubmission) => Promise<void>
}

export function QuestionCard({ questions, input, disabled, stopControl, onResolve }: QuestionCardProps) {
  const draft = useSyncExternalStore(input.subscribe, input.getSnapshot)
  const [submitting, setSubmitting] = useState(false)
  const sending = useRef(false)
  const index = Math.max(0, questions.findIndex(item => item.id === draft?.currentId))
  const question = questions[index]
  if (!question) return null
  const answers = draft?.answers ?? {}
  const value = answers[question.id]
  const text = value ?? ''
  const last = index === questions.length - 1
  const submission = last ? questionSubmission(questions, answers) : null
  const blocked = disabled || submitting
  const select = (id: string) => input.replace({ answers, currentId: id })
  const edit = (answer: string | null, advance = false) => input.replace({
    currentId: advance && !last ? questions[index + 1]!.id : question.id,
    answers: { ...answers, [question.id]: answer },
  })
  const advance = async () => {
    if (blocked || sending.current) return
    if (!last) {
      if (value === null || text.trim()) select(questions[index + 1]!.id)
      return
    }
    if (!submission) return
    sending.current = true
    setSubmitting(true)
    try { await onResolve(submission) }
    finally { sending.current = false; setSubmitting(false) }
  }
  return <form className="wc-question-composer" onSubmit={event => {
    event.preventDefault()
    void advance()
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
        aria-pressed={text === option.label} disabled={blocked} onClick={() => edit(option.label, true)}>
        <span className="wc-question-option-index" aria-hidden="true">{i + 1}</span>
        <span><span className="block font-medium">{option.label}</span>
          {option.description && <span className="wc-question-description">{option.description}</span>}</span>
      </button>)}
    </div>}
    <div className="wc-question-controls">
      <label className="wc-question-field"><Pencil size={14} />
        <textarea rows={1} className="wc-scrollbar max-h-40" aria-label="当前问题的回答"
          placeholder={value === null ? '已跳过，可重新填写' : '写下你的回答…'} value={text} disabled={blocked}
          onChange={event => edit(event.target.value)}
          onKeyDown={event => {
            const action = composerKeyAction(event.nativeEvent)
            if (action === 'ignore' || action === 'newline') return
            event.preventDefault()
            event.currentTarget.form?.requestSubmit()
          }} />
      </label>
      <button type="button" className="wc-settings-button wc-focus-ring" disabled={blocked}
        aria-pressed={value === null} onClick={() => edit(null, true)}>跳过</button>
      <button type="submit" className="wc-settings-button wc-focus-ring" data-variant="primary" disabled={blocked || (last ? !submission : value !== null && !text.trim())}>{last ? '发送' : '下一个'}</button>
      {stopControl}
    </div>
  </form>
}
