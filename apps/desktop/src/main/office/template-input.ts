import { OfficeProcessingError } from '@whycode/core/office'

export function bytes(value: unknown, message: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new OfficeProcessingError('corrupted', message)
  }
  return value
}

export function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new OfficeProcessingError('corrupted', `${name} 必须是数组`)
  return value
}

export function record(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OfficeProcessingError('corrupted', message)
  }
  return value as Record<string, unknown>
}
