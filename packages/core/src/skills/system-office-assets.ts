import { DOCUMENT_OFFICE_SKILL_FILES } from './system-office-documents.ts'
import { PRESENTATION_OFFICE_SKILL_FILES } from './system-office-presentations.ts'
import { SPREADSHEET_OFFICE_SKILL_FILES } from './system-office-spreadsheets.ts'
import type { EmbeddedOfficeSkillFile } from './system-office-shared.ts'

export const OFFICE_SYSTEM_SKILL_FILES: readonly EmbeddedOfficeSkillFile[] = [
  ...DOCUMENT_OFFICE_SKILL_FILES,
  ...PRESENTATION_OFFICE_SKILL_FILES,
  ...SPREADSHEET_OFFICE_SKILL_FILES,
]
