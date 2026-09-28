/** A transport failure after dispatch gives no authority to retry or compensate a mutation. */
export function unknownWorkspaceOutcome(detail: string): Error {
  return Object.assign(new Error(`${detail}；操作结果未知，请核实后重试`), { code: 'WORKSPACE_OUTCOME_UNKNOWN' })
}
export function isUnknownWorkspaceOutcome(error: unknown): error is Error & { code: 'WORKSPACE_OUTCOME_UNKNOWN' } {
  return error instanceof Error && 'code' in error && error.code === 'WORKSPACE_OUTCOME_UNKNOWN'
}
