import type { Block } from '../../shared/conversation-state.ts'
import { useContext } from 'react'
import type { RightPanelPage } from './right-panel-state.ts'
import { MessageActions } from './message-actions.tsx'
import { PresentedFiles } from './presented-files.tsx'
import { ResponseFileChanges } from './response-file-changes.tsx'
import { SourceCapsule } from './source-capsules.tsx'
import { copyResponseText, ResponsePresentationContext } from './response-presentation.ts'

export function ResponseFooter({ runtimeId, activity, final, onOpenFile, onFork, forkPending }: {
  runtimeId: string
  activity: readonly Block[]
  final: readonly Block[]
  onOpenFile?: (page: Extract<RightPanelPage, { kind: 'file' }>) => void
  onFork?: () => void
  forkPending: boolean
}) {
  const presentation = useContext(ResponsePresentationContext)
  const texts = final.filter(block => block.kind === 'text')
  if (!texts.length) return null
  return <div className="px-1 pb-2" data-response-footer>
    {presentation?.files.length ? <PresentedFiles files={presentation.files} runtimeId={runtimeId} onOpenFile={onOpenFile} /> : null}
    <ResponseFileChanges runtimeId={runtimeId} activity={activity} files={presentation?.files ?? []} />
    {presentation?.sources.length ? (
      <div className="wc-source-list" role="list" aria-label="来源">
        {presentation.sources.map(source => <div className="wc-source-item" role="listitem" key={source.url}>
          <SourceCapsule source={source} />
        </div>)}
      </div>
    ) : null}
    <MessageActions timestamp={texts.at(-1)?.timestamp}
      text={copyResponseText(texts.map(block => block.text).join('\n\n'), presentation)}
      className="mt-2" onFork={onFork} forkPending={forkPending} />
  </div>
}
