import type { ComposerDraft } from './composer-drafts.ts'
import { PendingImageGallery } from './image-attachments.tsx'
import { PdfDraftStrip } from './pdf-attachments.tsx'
import { SkillBadges } from './skill-picker.tsx'
import { UserMessageBubble } from './user-message-card.tsx'
import { CodeReferenceChips } from './code-reference-chips.tsx'

/** 单条输入只在正式时间线接替前显示预览。 */
export function PendingUserMessage(props: { draft: ComposerDraft } | { answer: string }) {
  const draft = 'draft' in props ? props.draft : undefined
  const text = 'answer' in props ? props.answer : props.draft.text
  return (
    <div
      aria-label={draft ? '正在提交的消息' : '已提交的回答'}
      aria-busy={draft ? true : undefined}
      className="wc-user-message-copy mb-2 ml-auto flex w-full min-w-0 max-w-[84%] flex-col items-end gap-2"
    >
      {draft && <>
        <PendingImageGallery drafts={draft.images} />
        <PdfDraftStrip drafts={draft.pdfs} variant="message" />
        <SkillBadges skills={draft.skills} />
        <CodeReferenceChips items={draft.codeReferences} />
      </>}
      {text && <UserMessageBubble text={text} btw={Boolean(draft?.btwMode)} />}
      <div aria-hidden="true" className="wc-message-actions wc-type-caption -mt-1" />
    </div>
  )
}
