import { useState, type FormEvent, type KeyboardEvent } from 'react'
import {
  type UserQuestion,
  type UserQuestionItem,
} from '@whycode/core/events'
import {
  advanceQuestionProgress,
  previousQuestionIndex,
} from './question-progress.ts'

interface QuestionCardProps {
  question: UserQuestion
  disabled: boolean
  onAnswer: (answers: string[]) => void
}

interface QuestionProgress {
  currentIndex: number
  current: UserQuestionItem
  currentAnswer: string
  isLast: boolean
  updateCurrent: (answer: string) => void
  advance: (answer?: string) => void
  previous: () => void
}

export function QuestionCard({ question, disabled, onAnswer }: QuestionCardProps) {
  const items = question.questions
  const progress = useQuestionProgress(items, disabled, onAnswer)
  return (
    <form
      className="wc-paper-card wc-paper-blue wc-paper-shape-a wc-paper-compact-pad text-sm"
      onSubmit={(event) => submitQuestion(event, progress.advance)}
    >
      <QuestionHeading
        item={progress.current}
        currentIndex={progress.currentIndex}
        total={items.length}
      />
      <QuestionOptions
        item={progress.current}
        answer={progress.currentAnswer}
        disabled={disabled}
        onSelect={progress.updateCurrent}
        onAdvance={progress.advance}
      />
      <QuestionControls progress={progress} disabled={disabled} />
    </form>
  )
}

function useQuestionProgress(
  items: readonly UserQuestionItem[],
  disabled: boolean,
  onAnswer: (answers: string[]) => void,
): QuestionProgress {
  const [currentIndex, setCurrentIndex] = useState(0)
  const [answers, setAnswers] = useState(() => items.map(() => ''))
  const current = items[currentIndex]!
  const currentAnswer = answers[currentIndex] ?? ''
  const isLast = currentIndex === items.length - 1
  const updateCurrent = (answer: string) => {
    setAnswers((previous) => previous.map((value, index) =>
      index === currentIndex ? answer : value))
  }
  const advance = (selectedAnswer?: string) => {
    if (disabled) return
    const advanced = advanceQuestionProgress(
      answers,
      currentIndex,
      selectedAnswer ?? currentAnswer,
    )
    if (!advanced) return
    if (advanced.complete) onAnswer(advanced.answers)
    else {
      setAnswers(advanced.answers)
      setCurrentIndex(advanced.nextIndex)
    }
  }
  return {
    currentIndex,
    current,
    currentAnswer,
    isLast,
    updateCurrent,
    advance,
    previous: () => setCurrentIndex(previousQuestionIndex),
  }
}

function QuestionHeading({
  item,
  currentIndex,
  total,
}: {
  item: UserQuestionItem
  currentIndex: number
  total: number
}) {
  return (
    <>
      <div className="mb-1 flex items-center justify-between gap-3 text-xs font-medium text-[var(--wc-blue-ink)]">
        <span>{item.header}</span>
        {total > 1 && <span>{currentIndex + 1} / {total}</span>}
      </div>
      <div className="mb-3 font-medium text-[var(--wc-ink)]">{item.question}</div>
    </>
  )
}

function QuestionOptions({
  item,
  answer,
  disabled,
  onSelect,
  onAdvance,
}: {
  item: UserQuestionItem
  answer: string
  disabled: boolean
  onSelect: (answer: string) => void
  onAdvance: (answer: string) => void
}) {
  return (
    <div className="mb-3 grid gap-2 sm:grid-cols-2">
      {item.options.map((option, index) => (
        <button
          key={`${index}-${option.label}`}
          type="button"
          className={`wc-focus-ring rounded-xl border bg-white/85 p-2.5 text-left disabled:opacity-40 ${
            answer === option.label
              ? 'border-[#81939c] ring-1 ring-[#81939c]/30'
              : 'border-[var(--wc-line)] hover:border-[var(--wc-line-strong)]'
          }`}
          disabled={disabled}
          aria-pressed={answer === option.label}
          onClick={() => onSelect(option.label)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            onAdvance(option.label)
          }}
        >
          <div className="font-medium text-[var(--wc-ink)]">{option.label}</div>
          <div className="mt-0.5 text-xs text-[var(--wc-muted)]">{option.description}</div>
        </button>
      ))}
    </div>
  )
}

function QuestionControls({
  progress,
  disabled,
}: {
  progress: QuestionProgress
  disabled: boolean
}) {
  const preventComposingSubmit = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault()
  }
  return (
    <div className="flex gap-2">
      {progress.currentIndex > 0 && (
        <button
          type="button"
          className="wc-focus-ring rounded-xl border border-[var(--wc-line)] bg-white px-3 py-1.5 text-[var(--wc-muted)] disabled:opacity-40"
          disabled={disabled}
          onClick={progress.previous}
        >
          上一个
        </button>
      )}
      <input
        key={progress.currentIndex}
        className="wc-focus-ring min-w-0 flex-1 rounded-xl border border-[var(--wc-line)] bg-white px-2.5 py-1.5 text-sm outline-none"
        value={progress.currentAnswer}
        disabled={disabled}
        autoFocus={progress.currentIndex > 0}
        aria-label="当前问题的回答"
        placeholder="选择一个答案，或者直接输入"
        onChange={(event) => progress.updateCurrent(event.target.value)}
        onKeyDown={preventComposingSubmit}
      />
      <button
        type="submit"
        className="wc-focus-ring rounded-xl bg-[var(--wc-ink)] px-3 py-1.5 text-white disabled:opacity-40"
        disabled={disabled || !progress.currentAnswer.trim()}
      >
        {progress.isLast ? '回答' : '下一个'}
      </button>
    </div>
  )
}

function submitQuestion(event: FormEvent, advance: (answer?: string) => void): void {
  event.preventDefault()
  advance()
}
