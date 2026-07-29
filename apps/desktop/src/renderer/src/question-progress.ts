export interface QuestionAdvance {
  answers: string[]
  nextIndex: number
  complete: boolean
}

/** 回车、选项键盘确认与表单按钮共用这一条逐题推进语义。 */
export function advanceQuestionProgress(
  answers: readonly string[],
  currentIndex: number,
  answer: string,
): QuestionAdvance | null {
  if (currentIndex < 0 || currentIndex >= answers.length) return null
  const normalized = answer.trim()
  if (!normalized) return null
  const next = answers.map((value, index) =>
    index === currentIndex ? normalized : value.trim())
  const complete = currentIndex === answers.length - 1
  return {
    answers: next,
    nextIndex: complete ? currentIndex : currentIndex + 1,
    complete,
  }
}

export function previousQuestionIndex(currentIndex: number): number {
  return Math.max(0, currentIndex - 1)
}
