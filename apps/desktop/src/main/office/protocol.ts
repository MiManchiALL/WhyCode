import type {
  OfficeArtifactAsset,
  OfficeFormat,
  OfficeInspectOptions,
  OfficeInspection,
  OfficeProcessingErrorCode,
} from '@whycode/core/office'

interface OfficeWorkerRequestBase {
  id: string
}

export type OfficeWorkerRequest =
  | OfficeWorkerRequestBase & {
      operation: 'inspect'
      path: string
      options: OfficeInspectOptions
    }
  | OfficeWorkerRequestBase & {
      operation: 'build'
      format: OfficeFormat
      scriptPath: string
      outputPath: string
      assets: OfficeArtifactAsset[]
    }

export type OfficeWorkerResult =
  | { operation: 'inspect'; inspection: OfficeInspection }
  | { operation: 'build'; inspection: OfficeInspection; progress: string[] }

export type OfficeWorkerResponse =
  | { id: string; ok: true; result: OfficeWorkerResult }
  | {
      id: string
      ok: false
      error: { code: OfficeProcessingErrorCode; message: string }
    }
