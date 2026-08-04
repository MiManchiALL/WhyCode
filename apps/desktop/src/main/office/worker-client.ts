import {
  OfficeProcessingError,
  officeTemplateComparisonSchema,
  officeInspectionSchema,
  type OfficeProcessingErrorCode,
} from '@whycode/core/office'
import {
  runUtilityProcessJob,
  UtilityProcessJobError,
} from '../utility-process-job.ts'
import type {
  OfficeWorkerRequest,
  OfficeWorkerResponse,
  OfficeWorkerResult,
} from './protocol.ts'

const ERROR_CODES: ReadonlySet<string> = new Set([
  'aborted', 'corrupted', 'empty', 'invalid-range', 'renderer-unavailable',
  'timeout', 'too-large', 'unsupported', 'unknown',
])

export async function runOfficeWorker(
  request: OfficeWorkerRequest,
  abortSignal: AbortSignal,
  timeoutMs: number,
  maxOldSpaceSizeMb: number,
): Promise<OfficeWorkerResult> {
  try {
    const response = await runUtilityProcessJob({
      workerName: 'office-worker.js',
      serviceName: 'WhyCode Office Processor',
      request,
      abortSignal,
      timeoutMs,
      maxOldSpaceSizeMb,
    })
    if (!isOfficeWorkerResponse(response, request)) {
      throw new OfficeProcessingError('unknown', 'Office 子进程返回了无效响应')
    }
    if (response.ok) return response.result
    throw new OfficeProcessingError(response.error.code, response.error.message)
  } catch (error) {
    if (error instanceof OfficeProcessingError) throw error
    if (!(error instanceof UtilityProcessJobError)) {
      throw new OfficeProcessingError('unknown', 'Office 子进程处理失败', { cause: error })
    }
    if (error.failure === 'aborted') {
      throw new OfficeProcessingError('aborted', 'Office 处理已取消')
    }
    if (error.failure === 'timeout') {
      throw new OfficeProcessingError('timeout', 'Office 处理超时，请缩小文件或任务后重试')
    }
    throw new OfficeProcessingError('unknown', error.message, { cause: error })
  }
}

function isOfficeWorkerResponse(
  value: unknown,
  request: OfficeWorkerRequest,
): value is OfficeWorkerResponse {
  if (!isRecord(value) || value.id !== request.id || typeof value.ok !== 'boolean') return false
  if (value.ok === false) return isWorkerError(value.error)
  if (!isRecord(value.result) || value.result.operation !== request.operation) return false
  if (request.operation === 'compare-template') {
    return officeTemplateComparisonSchema.safeParse(value.result.template).success
  }
  const inspection = officeInspectionSchema.safeParse(value.result.inspection)
  if (!inspection.success) return false
  if (request.operation === 'inspect') return !('progress' in value.result)
  return Array.isArray(value.result.progress)
    && value.result.progress.length <= 100
    && value.result.progress.every((line) => typeof line === 'string' && line.length <= 1_000)
}

function isWorkerError(
  value: unknown,
): value is { code: OfficeProcessingErrorCode; message: string } {
  return isRecord(value)
    && typeof value.code === 'string'
    && ERROR_CODES.has(value.code)
    && typeof value.message === 'string'
    && value.message.length <= 8_000
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
