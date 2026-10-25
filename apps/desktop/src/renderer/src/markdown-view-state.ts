import { createContext } from 'react'
import type { ConversationPresentationCache } from './conversation-presentation.ts'

export interface MarkdownViewOwner {
  key: string
  cache: ConversationPresentationCache
}

export const MarkdownViewOwnerContext = createContext<MarkdownViewOwner | null>(null)
export const MarkdownMessageIdContext = createContext<string | null>(null)
