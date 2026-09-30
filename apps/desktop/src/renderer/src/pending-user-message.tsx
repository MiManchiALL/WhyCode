import type { ComposerDraft } from './composer-drafts.ts'
import { ImageDraftStrip } from './image-attachments.tsx'
import { PdfDraftStrip } from './pdf-attachments.tsx'
import { SkillBadges } from './skill-picker.tsx'
import { UserMessageBubble } from './user-message-card.tsx'

/** 提交归属仍由 ComposerSubmissions 持有；这里仅展示，不能编辑或写入会话历史。 */
export function PendingUserMessage({ draft }: { draft: ComposerDraft }) {
  return (
    <div
      aria-label="正在提交的消息"
      aria-busy="true"
      className="wc-user-message-copy mb-2 ml-auto flex w-full min-w-0 max-w-[84%] flex-col items-end gap-2"
    >
      <ImageDraftStrip drafts={draft.images} />
      <PdfDraftStrip drafts={draft.pdfs} />
      <SkillBadges skills={draft.skills} />
      {draft.text && <UserMessageBubble text={draft.text} btw={Boolean(draft.btwMode)} />}
    </div>
  )
}
