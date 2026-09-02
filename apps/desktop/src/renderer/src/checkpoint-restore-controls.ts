export type CheckpointRestoreScope = 'files' | 'files-and-chat'
export type CheckpointRestoreRequestKind = 'check' | 'restore'

export type CheckpointRestoreRequest = (
  toolUseId: string,
  scope: CheckpointRestoreScope,
  kind: CheckpointRestoreRequestKind,
) => Promise<boolean>

export interface RestoreConfirmationAction {
  label: '取消' | '确认'
  action: 'cancel' | 'confirm'
}

/** 把确认放到首次所点按钮的另一侧，连续点击同一位置只会取消。 */
export function restoreConfirmationActions(
  scope: CheckpointRestoreScope,
): readonly [RestoreConfirmationAction, RestoreConfirmationAction] {
  const cancel = { label: '取消', action: 'cancel' } as const
  const confirm = { label: '确认', action: 'confirm' } as const
  return scope === 'files'
    ? [cancel, confirm]
    : [confirm, cancel]
}
