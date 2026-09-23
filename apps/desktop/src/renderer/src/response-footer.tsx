import type { Block } from '../../shared/conversation-state.ts'
import type { Presentation } from '@whycode/core/presentation'
import { useContext } from 'react'
import type { RightPanelPage } from './right-panel-state.ts'
import { MessageActions } from './message-actions.tsx'
import { PresentedFiles } from './presented-files.tsx'
import { ResponseFileChanges } from './response-file-changes.tsx'
import { SourceCapsule } from './source-capsules.tsx'
import { copyResponseText, ResponseSourcesContext } from './response-presentation.ts'

export function ResponseFooter({ runtimeId, projectDir, activity, final, presentation, onOpenFile, onOpenChanges, onRevealRestore, onFork, forkPending }: {
  runtimeId: string
  projectDir: string | null
  activity: readonly Block[]
  final: readonly Block[]
  presentation: Presentation | null
  onOpenFile?: (page: Extract<RightPanelPage, { kind: 'file' }>) => void
  onOpenChanges?: (page: Extract<RightPanelPage, { kind: 'changes' }>) => void
  onRevealRestore?: () => void
  onFork?: () => void
  forkPending: boolean
}) {
  const response = useContext(ResponseSourcesContext)
  const texts = final.filter(block => block.kind === 'text')
  if (!texts.length || !response) return null
  return <div className="px-1 pb-2" data-response-footer>
    {presentation?.files.length ? <PresentedFiles files={presentation.files} runtimeId={runtimeId} onOpenFile={onOpenFile} /> : null}
    <ResponseFileChanges runtimeId={runtimeId} projectDir={projectDir} activity={activity} onOpenChanges={onOpenChanges} onRevealRestore={onRevealRestore} />
    {response.sources.length ? (
      <div className="wc-source-list" role="list" aria-label="来源">
        {response.sources.map(source => <div className="wc-source-item" role="listitem" key={source.url}>
          <SourceCapsule source={source} />
        </div>)}
      </div>
    ) : null}
    <MessageActions timestamp={texts.at(-1)?.timestamp}
      text={copyResponseText(response, presentation)}
      className="mt-2" onFork={onFork} forkPending={forkPending} />
  </div>
}
