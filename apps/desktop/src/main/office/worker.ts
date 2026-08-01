import type { OfficeProcessingErrorCode } from '@whycode/core/office'
import { buildOfficeFile } from './build-engine.ts'
import { inspectOfficeFile } from './inspect.ts'
import type { OfficeWorkerRequest, OfficeWorkerResponse } from './protocol.ts'

const parentPort = process.parentPort
if (!parentPort) throw new Error('Office utility process 缺少 parentPort')

parentPort.once('message', async (event) => {
  const request = event.data as OfficeWorkerRequest
  let response: OfficeWorkerResponse
  try {
    const result = request.operation === 'inspect'
      ? {
          operation: 'inspect' as const,
          inspection: await inspectOfficeFile(request.path, request.options),
        }
      : {
          operation: 'build' as const,
          ...await buildOfficeFile(request),
        }
    response = { id: request.id, ok: true, result }
  } catch (error) {
    response = { id: request.id, ok: false, error: serializeError(error) }
  }
  parentPort.postMessage(response)
  setTimeout(() => process.exit(response.ok ? 0 : 1), 0)
})

function serializeError(error: unknown): { code: OfficeProcessingErrorCode; message: string } {
  return {
    code: isOfficeError(error) ? error.code : 'unknown',
    message: error instanceof Error ? error.message : String(error),
  }
}

function isOfficeError(error: unknown): error is Error & { code: OfficeProcessingErrorCode } {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
}
