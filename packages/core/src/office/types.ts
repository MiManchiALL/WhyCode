import { z } from 'zod'

export const OFFICE_ARTIFACT_MAX_SOURCE_BYTES = 100_000_000
export const OFFICE_ARTIFACT_MAX_ASSETS = 32
export const OFFICE_ARTIFACT_MAX_ASSET_BYTES = 50_000_000
export const OFFICE_ARTIFACT_MAX_TOTAL_ASSET_BYTES = 150_000_000
export const OFFICE_BUILDER_MAX_SCRIPT_BYTES = 512_000
export const OFFICE_INSPECT_DEFAULT_UNITS = 20
export const OFFICE_INSPECT_MAX_UNITS = 50
export const OFFICE_INSPECT_MAX_TEXT_CHARS = 60_000
export const OFFICE_RENDER_MAX_PAGES = 4

export const officeFormatSchema = z.enum(['docx', 'pptx', 'xlsx'])
export type OfficeFormat = z.infer<typeof officeFormatSchema>

export const officeUnitKindSchema = z.enum(['block', 'slide', 'sheet', 'row'])
export type OfficeUnitKind = z.infer<typeof officeUnitKindSchema>

export const officeInspectionUnitSchema = z.object({
  index: z.number().int().positive(),
  label: z.string().min(1).max(255),
  text: z.string().max(OFFICE_INSPECT_MAX_TEXT_CHARS),
})
export type OfficeInspectionUnit = z.infer<typeof officeInspectionUnitSchema>

export const officeInspectionSchema = z.object({
  format: officeFormatSchema,
  byteLength: z.number().int().positive().max(OFFICE_ARTIFACT_MAX_SOURCE_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  unitKind: officeUnitKindSchema,
  unitCount: z.number().int().nonnegative(),
  units: z.array(officeInspectionUnitSchema).max(OFFICE_INSPECT_MAX_UNITS),
  nextUnit: z.number().int().positive().nullable(),
  metadata: z.array(z.string().min(1).max(1_000)).max(100),
  formulaCount: z.number().int().nonnegative(),
  formulaErrorCount: z.number().int().nonnegative(),
}).superRefine((inspection, ctx) => {
  const totalText = inspection.units.reduce((total, unit) => total + unit.text.length, 0)
  if (totalText > OFFICE_INSPECT_MAX_TEXT_CHARS) {
    ctx.addIssue({ code: 'custom', path: ['units'], message: 'Office 检查文字超过上限' })
  }
})

export type OfficeInspection = z.infer<typeof officeInspectionSchema>

export interface OfficeInspectOptions {
  startUnit: number
  unitCount: number
  sheetName?: string
}

export interface OfficeRenderOptions {
  startPage: number
  pageCount: number
  outputDirectory: string
}

export interface OfficeRenderedPage {
  pageNumber: number
  path: string
  width: number
  height: number
}

export interface OfficeRenderResult {
  format: OfficeFormat
  pageCount: number
  renderer: 'libreoffice' | 'microsoft-office'
  renderedPages: OfficeRenderedPage[]
}

export type OfficeProcessingErrorCode =
  | 'aborted'
  | 'corrupted'
  | 'empty'
  | 'invalid-range'
  | 'renderer-unavailable'
  | 'timeout'
  | 'too-large'
  | 'unsupported'
  | 'unknown'

export class OfficeProcessingError extends Error {
  readonly code: OfficeProcessingErrorCode

  constructor(code: OfficeProcessingErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'OfficeProcessingError'
    this.code = code
  }
}

export interface OfficeProcessor {
  inspect(
    path: string,
    options: OfficeInspectOptions,
    abortSignal: AbortSignal,
  ): Promise<OfficeInspection>
  renderPages(
    path: string,
    options: OfficeRenderOptions,
    abortSignal: AbortSignal,
  ): Promise<OfficeRenderResult>
}

export interface OfficeArtifactAsset {
  key: string
  path: string
}

export interface OfficeArtifactBuildRequest {
  format: OfficeFormat
  scriptPath: string
  outputPath: string
  assets: OfficeArtifactAsset[]
}

export interface OfficeArtifactBuildResult {
  outputPath: string
  inspection: OfficeInspection
}

export interface OfficeArtifactRunner {
  build(
    request: OfficeArtifactBuildRequest,
    abortSignal: AbortSignal,
    onProgress?: (output: string) => void,
  ): Promise<OfficeArtifactBuildResult>
}

export function officeExtension(format: OfficeFormat): `.${OfficeFormat}` {
  return `.${format}`
}
