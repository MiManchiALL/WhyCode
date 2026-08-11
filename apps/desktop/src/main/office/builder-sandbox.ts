import 'ses'
import * as docx from 'docx'
import ExcelJS from 'exceljs'
import * as fastXml from 'fast-xml-parser'
import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'
import { OfficeProcessingError, type OfficeFormat } from '@whycode/core/office'
import { OFFICE_TEMPLATE_CAPABILITY } from './template-kit.ts'

export interface OfficeBuildAsset {
  name: string
  extension: string
  bytes: Uint8Array
  base64: string
  dataUri: string
  text: string
}

type Builder = (context: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>

const BLOCKED_METHODS = new Set([
  'createInputStream',
  'exportPresentation',
  'readFile',
  'stream',
  'tableToSlides',
  'writeFile',
  'writeFileToBrowser',
])
const PATH_KEYS = new Set(['fileName', 'filename', 'path'])

lockdown({ errorTaming: 'safe', consoleTaming: 'safe' })

export async function runOfficeBuilder(options: {
  source: string
  format: OfficeFormat
  assets: Readonly<Record<string, OfficeBuildAsset>>
  report: (value: unknown) => void
}): Promise<unknown> {
  const membrane = createOfficeMembrane()
  const globals = Object.freeze({
    format: options.format,
    docx: Object.freeze({ ...docx }),
    PptxGenJS: membrane.constructor(PptxGenJS),
    ExcelJS: Object.freeze({ Workbook: membrane.constructor(ExcelJS.Workbook) }),
    JSZip,
    fastXml: Object.freeze({ ...fastXml }),
    OfficeTemplate: harden(OFFICE_TEMPLATE_CAPABILITY),
    assets: options.assets,
    report: harden(options.report),
  })
  const compartment = new Compartment({ globals, __options__: true })
  let value: unknown
  try {
    value = compartment.evaluate(options.source)
  } catch (error) {
    throw new OfficeProcessingError(
      'corrupted',
      `Office 构建脚本编译失败：${message(error)}`,
      { cause: error },
    )
  }
  if (typeof value !== 'function') {
    throw new OfficeProcessingError('corrupted', 'Office 构建脚本的求值结果必须是构建函数')
  }
  try {
    return membrane.unwrap(await (value as Builder)(globals))
  } catch (error) {
    throw new OfficeProcessingError(
      'corrupted',
      `Office 构建脚本执行失败：${message(error)}`,
      { cause: error },
    )
  }
}

function createOfficeMembrane(): {
  constructor: <T extends new (...args: never[]) => object>(value: T) => T
  unwrap: (value: unknown) => unknown
} {
  const targets = new WeakMap<object, object>()
  const facades = new WeakMap<object, object>()

  const unwrap = (value: unknown): unknown => isObject(value) ? targets.get(value) ?? value : value
  const unwrapDeep = (value: unknown): unknown => {
    const direct = unwrap(value)
    if (direct !== value) return direct
    if (value instanceof Uint8Array) return value
    if (Array.isArray(value)) return value.map(unwrapDeep)
    if (!isRecord(value) || !isPlainData(value)) return value
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, unwrapDeep(entry)]))
  }
  const wrap = (value: unknown): unknown => {
    if (!isObject(value) || isPlainData(value)) return value
    const existing = facades.get(value)
    if (existing) return existing
    const facade = new Proxy(Object.create(null) as object, {
      get: (_target, property) => {
        if (property === Symbol.toStringTag) return 'OfficeCapability'
        if (property === 'constructor' || property === '__proto__') return undefined
        if (typeof property === 'string' && BLOCKED_METHODS.has(property)) {
          return () => { throw new Error(`Office 构建环境不开放 ${property}`) }
        }
        const member = Reflect.get(value, property, value)
        if (typeof member !== 'function') return wrap(member)
        return (...args: unknown[]) => {
          requireNoAmbientPath(args)
          return wrap(Reflect.apply(member, value, args.map(unwrapDeep)))
        }
      },
      set: (_target, property, next) => {
        requireNoAmbientPath(next)
        return Reflect.set(value, property, unwrapDeep(next), value)
      },
      has: (_target, property) => property in value,
      ownKeys: () => Reflect.ownKeys(value),
      getOwnPropertyDescriptor: (_target, property) => {
        if (!(property in value)) return undefined
        return {
          configurable: true,
          enumerable: Reflect.getOwnPropertyDescriptor(value, property)?.enumerable ?? true,
          writable: true,
          value: wrap(Reflect.get(value, property, value)),
        }
      },
      getPrototypeOf: () => null,
    })
    targets.set(facade, value)
    facades.set(value, facade)
    return facade
  }

  return {
    constructor: ((value: new (...args: never[]) => object) => {
      const construct = new Proxy(function officeConstructor() {}, {
        construct: (_target, args) => wrap(Reflect.construct(value, args.map(unwrapDeep))) as object,
        get: (_target, property) => {
          if (property === 'constructor' || property === 'prototype' || property === '__proto__') {
            return undefined
          }
          return wrap(Reflect.get(value, property, value))
        },
        getPrototypeOf: () => null,
      })
      return construct as unknown as typeof value
    }) as <T extends new (...args: never[]) => object>(value: T) => T,
    unwrap,
  }
}

function requireNoAmbientPath(value: unknown, seen = new WeakSet<object>()): void {
  if (!isObject(value) || seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((entry) => requireNoAmbientPath(entry, seen))
    return
  }
  for (const [key, entry] of Object.entries(value)) {
    if (PATH_KEYS.has(key) && typeof entry === 'string') {
      throw new Error(`Office 构建资源必须通过 assets 注入，参数 ${key} 不接受路径`)
    }
    requireNoAmbientPath(entry, seen)
  }
}

function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isPlainData(value: object): boolean {
  return Array.isArray(value)
    || value instanceof Uint8Array
    || Object.getPrototypeOf(value) === Object.prototype
    || Object.getPrototypeOf(value) === null
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
