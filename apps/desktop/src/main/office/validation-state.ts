import type { OfficeValidationIssue } from '@whycode/core/office'
import type { OfficeArchive } from './archive.ts'

export interface ValidationState {
  archive: OfficeArchive
  issues: OfficeValidationIssue[]
  relationshipCount: number
  internalRelationshipCount: number
}

export function validationIssue(
  state: ValidationState,
  code: string,
  severity: OfficeValidationIssue['severity'],
  location: string,
  message: string,
): void {
  const next = { code, severity, location, message }
  if (state.issues.length < 100) {
    state.issues.push(next)
    return
  }
  if (severity === 'error') {
    const warning = state.issues.findLastIndex((issue) => issue.severity === 'warning')
    if (warning >= 0) state.issues[warning] = next
  }
}
