import {
  officeInspectionSchema,
  type OfficeFormat,
  type OfficeInspectOptions,
  type OfficeInspection,
} from '@whycode/core/office'
import { openOfficeArchive } from './archive.ts'
import { inspectDocx } from './inspect-docx.ts'
import { inspectPptx } from './inspect-pptx.ts'
import { inspectXlsx } from './inspect-xlsx.ts'
import { relationshipView, validationView } from './inspect-common.ts'
import { validateOfficePackage } from './validate-package.ts'

export async function inspectOfficeFile(
  path: string,
  options: OfficeInspectOptions,
  expectedFormat?: OfficeFormat,
): Promise<OfficeInspection> {
  const archive = await openOfficeArchive(path, expectedFormat)
  const validation = await validateOfficePackage(archive)
  let inspection = archive.format === 'docx'
    ? await inspectDocx(archive, options)
    : archive.format === 'pptx'
      ? await inspectPptx(archive, options)
      : await inspectXlsx(archive, options)
  if (options.view === 'relationships') {
    inspection = await relationshipView(archive, inspection, options)
  } else if (options.view === 'validation') {
    inspection = validationView(inspection, validation, options)
  }
  return officeInspectionSchema.parse({ ...inspection, validation })
}
