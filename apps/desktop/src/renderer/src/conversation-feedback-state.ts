export type ConversationFeedbackPhase = 'visible' | 'held' | 'exiting'

export function holdConversationFeedback(
  phase: ConversationFeedbackPhase,
): ConversationFeedbackPhase {
  return phase === 'visible' ? 'held' : phase
}

export function expireConversationFeedback(
  phase: ConversationFeedbackPhase,
): ConversationFeedbackPhase {
  return phase === 'visible' ? 'exiting' : phase
}

export function releaseConversationFeedback(
  phase: ConversationFeedbackPhase,
): ConversationFeedbackPhase {
  return phase === 'held' ? 'exiting' : phase
}
