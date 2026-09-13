import type { ToolCall } from './conversation-state.ts'
import { toolCallFileRows, type ToolBatchRow } from './conversation-tool-batches.ts'
import { FadedScrollArea } from './faded-scroll-area.tsx'
import { InlineFileChange } from './file-change-view.tsx'
import { UserImageGallery } from './image-attachments.tsx'
import { CopyButton } from './message-actions.tsx'
import { isFilePreviewToolName } from './right-panel-state.ts'
import { toolCallDetails } from './tool-call-summary.ts'
import { TaskPlanView } from './task-plan-view.tsx'
import { parseTaskToolResult, type TaskToolResult } from './task-tool-result.ts'

export function ToolCallDetails({
  runtimeId,
  call,
  projectDir = null,
  file,
}: {
  runtimeId: string
  call: ToolCall
  projectDir?: string | null
  file?: Pick<ToolBatchRow, 'summary' | 'fullPath' | 'added' | 'removed'>
}) {
  if (
    call.status === 'done'
    && call.createdFileCheckpoint
    && isFilePreviewToolName(call.name)
    && call.name !== 'MoveFile'
  ) {
    const preview = file ?? (call.name === 'WriteFile'
      ? toolCallFileRows(call, projectDir)[0]
      : undefined)
    if (preview?.fullPath) {
      return (
        <InlineFileChange
          runtimeId={runtimeId}
          toolUseId={call.id}
          toolName={call.name}
          path={preview.fullPath}
          name={preview.summary}
          added={preview.added}
          removed={preview.removed}
        />
      )
    }
  }
  const taskResult = parseTaskToolResult(call)
  if (taskResult) return <TaskToolDetails key={`${runtimeId}:${call.id}`} result={taskResult} />
  const customDetails = toolCallDetails(call.name, call.input, call.result, call.status === 'error')
  const details = customDetails ?? call.result ?? call.progress
  const command = call.name === 'RunCommand' ? runCommand(call.input) : null
  if (!details && !call.attachments?.length && command === null) return null
  return (
    <div className="wc-tool-details overflow-hidden rounded-xl">
      {command !== null ? <CommandDetails command={command} /> : null}
      {call.attachments?.length ? (
        <div className="border-b border-[var(--wc-line)] px-3 pt-2">
          <UserImageGallery attachments={call.attachments} variant="tool" />
        </div>
      ) : null}
      {details ? (
        <div className="wc-tool-copy-scope relative">
          <FadedScrollArea className="wc-scrollbar max-h-44 overflow-y-auto">
            <pre className={`whitespace-pre-wrap break-words px-3 py-2 text-xs leading-5 ${command !== null ? 'pr-9' : ''}`}>
              {details}
            </pre>
          </FadedScrollArea>
          {command !== null ? (
            <CopyButton
              text={details}
              label="复制命令输出"
              ariaLabel="复制命令输出"
              className="wc-tool-copy-button absolute top-2 right-2 text-[var(--wc-faint)]"
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function TaskToolDetails({ result }: { result: TaskToolResult }) {
  return (
    <div className="wc-tool-details overflow-hidden rounded-xl">
      <FadedScrollArea className="wc-scrollbar max-h-72 overflow-y-auto">
        <div className="space-y-2 px-3 py-2 text-xs">
          <p className={`whitespace-pre-wrap break-words leading-5 ${result.ok ? 'text-[var(--wc-muted)]' : 'text-[var(--wc-danger)]'}`}>
            {result.message}
          </p>
          {result.plan && (
            <>
              <p className="whitespace-pre-wrap break-words font-medium leading-5 text-[var(--wc-ink)]">{result.plan.goal}</p>
              <TaskPlanView plan={result.plan} historical updatedItemIds={result.updatedItemIds} />
            </>
          )}
        </div>
      </FadedScrollArea>
    </div>
  )
}

function CommandDetails({ command }: { command: string }) {
  return (
    <div className="wc-tool-copy-scope relative border-b border-[var(--wc-line)] px-3 py-2 pr-9">
      <div className="mb-1 text-xs text-[var(--wc-faint)]">Shell</div>
      <pre className="whitespace-pre-wrap break-words text-xs leading-5">$ {command}</pre>
      <CopyButton
        text={command}
        label="复制完整命令"
        ariaLabel="复制完整命令"
        className="wc-tool-copy-button absolute top-2 right-2 text-[var(--wc-faint)]"
      />
    </div>
  )
}

function runCommand(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ''
  const command = (input as Record<string, unknown>).command
  return typeof command === 'string' ? command : ''
}
