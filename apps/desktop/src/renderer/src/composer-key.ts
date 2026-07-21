export type ComposerKeyAction = 'ignore' | 'newline' | 'send' | 'send-immediately'

export function composerKeyAction(input: {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  isComposing: boolean
}): ComposerKeyAction {
  if (input.key !== 'Enter' || input.isComposing) return 'ignore'
  if (input.shiftKey) return 'newline'
  return input.ctrlKey ? 'send-immediately' : 'send'
}
