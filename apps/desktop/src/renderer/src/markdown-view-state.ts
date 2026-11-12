import { createContext } from 'react'
import type { ConversationPresentationCache } from './conversation-presentation.ts'
import type { ResponseFileChangesResult } from './response-file-changes-data.ts'

export interface MarkdownViewOwner {
  key: string
  cache: ConversationPresentationCache
  initialFileChanges?: ResponseFileChangesResult
}

export const MarkdownViewOwnerContext = createContext<MarkdownViewOwner | null>(null)
export const MarkdownMessageIdContext = createContext<string | null>(null)
