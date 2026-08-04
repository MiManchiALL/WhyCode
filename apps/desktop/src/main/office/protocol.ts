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
  | OfficeWorkerRequestBase & {
      operation: 'compare-template'
      format: OfficeFormat
      templatePath: string
      outputPath: string
    }

export type OfficeWorkerResult =
  | { operation: 'inspect'; inspection: OfficeInspection }
  | { operation: 'build'; inspection: OfficeInspection; progress: string[] }
  | {
      operation: 'compare-template'
      template: import('@whycode/core/office').OfficeTemplateComparison
    }

export type OfficeWorkerResponse =
  | { id: string; ok: true; result: OfficeWorkerResult }
  | {
      id: string
      ok: false
      error: { code: OfficeProcessingErrorCode; message: string }
    }
