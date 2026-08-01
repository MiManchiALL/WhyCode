import { readFile, writeFile } from 'node:fs/promises'
import { extname } from 'node:path'
import * as docx from 'docx'
import ExcelJS from 'exceljs'
import * as fastXml from 'fast-xml-parser'
import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'
import {
  OFFICE_ARTIFACT_MAX_ASSET_BYTES,
  OFFICE_ARTIFACT_MAX_ASSETS,
  OFFICE_ARTIFACT_MAX_SOURCE_BYTES,
  OFFICE_ARTIFACT_MAX_TOTAL_ASSET_BYTES,
  OFFICE_BUILDER_MAX_SCRIPT_BYTES,
  OfficeProcessingError,
  officeExtension,
  type OfficeArtifactAsset,
  type OfficeFormat,
  type OfficeInspection,
} from '@whycode/core/office'
import { inspectOfficeFile } from './inspect.ts'

interface BuildAsset {
  name: string
  extension: string
  bytes: Buffer
  base64: string
  dataUri: string
}

export async function buildOfficeFile(options: {
  format: OfficeFormat
  scriptPath: string
  outputPath: string
  assets: OfficeArtifactAsset[]
}): Promise<{ inspection: OfficeInspection; progress: string[] }> {
  if (extname(options.outputPath).toLowerCase() !== officeExtension(options.format)) {
    throw new OfficeProcessingError('unsupported', `输出扩展名必须是 ${officeExtension(options.format)}`)
  }
  if (options.assets.length > OFFICE_ARTIFACT_MAX_ASSETS) {
    throw new OfficeProcessingError('too-large', `构建资源最多 ${OFFICE_ARTIFACT_MAX_ASSETS} 个`)
  }
  const source = await readUtf8Script(options.scriptPath)
  const assets = await readAssets(options.assets)
  const progress: string[] = []
  const report = (value: unknown) => {
    if (progress.length >= 100) return
    const text = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
    if (text) progress.push(text.slice(0, 1_000))
  }
  const builder = compileBuilder(source)
  const artifact = await builder({
    format: options.format,
    docx,
    PptxGenJS,
    ExcelJS,
    fastXml,
    JSZip,
    assets,
    report,
  })
  const bytes = await serializeArtifact(options.format, artifact)
  if (bytes.byteLength <= 0 || bytes.byteLength > OFFICE_ARTIFACT_MAX_SOURCE_BYTES) {
    throw new OfficeProcessingError('too-large', '构建结果为空或超过 100 MB 上限')
  }
  await writeFile(options.outputPath, bytes, { flag: 'wx', mode: 0o600, flush: true })
  const inspection = await inspectOfficeFile(
    options.outputPath,
    { startUnit: 1, unitCount: 20 },
    options.format,
  )
  return { inspection, progress }
}

async function readUtf8Script(path: string): Promise<string> {
  const bytes = await readFile(path)
  if (bytes.byteLength <= 0 || bytes.byteLength > OFFICE_BUILDER_MAX_SCRIPT_BYTES) {
    throw new OfficeProcessingError(
      'too-large',
      `Office 构建脚本必须在 1-${OFFICE_BUILDER_MAX_SCRIPT_BYTES / 1_000} KB 之间`,
    )
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new OfficeProcessingError('corrupted', 'Office 构建脚本不是有效 UTF-8', { cause: error })
  }
}

async function readAssets(
  entries: readonly OfficeArtifactAsset[],
): Promise<Readonly<Record<string, BuildAsset>>> {
  const assets: Record<string, BuildAsset> = Object.create(null)
  let totalBytes = 0
  for (const entry of entries) {
    if (Object.hasOwn(assets, entry.key)) throw new OfficeProcessingError('corrupted', '构建资源 key 重复')
    const bytes = await readFile(entry.path)
    if (bytes.byteLength <= 0 || bytes.byteLength > OFFICE_ARTIFACT_MAX_ASSET_BYTES) {
      throw new OfficeProcessingError('too-large', `构建资源为空或超过 50 MB：${entry.key}`)
    }
    totalBytes += bytes.byteLength
    if (totalBytes > OFFICE_ARTIFACT_MAX_TOTAL_ASSET_BYTES) {
      throw new OfficeProcessingError('too-large', '构建资源总大小超过 150 MB')
    }
    const extension = extname(entry.path).slice(1).toLowerCase()
    const base64 = bytes.toString('base64')
    assets[entry.key] = Object.freeze({
      name: entry.path.split(/[\\/]/).at(-1) ?? entry.key,
      extension,
      bytes,
      base64,
      dataUri: `data:${assetMediaType(extension)};base64,${base64}`,
    })
  }
  return Object.freeze(assets)
}

function compileBuilder(source: string): (
  context: Record<string, unknown>,
) => unknown | Promise<unknown> {
  let value: unknown
  try {
    // 构建函数必须与注入库处于同一 JS Realm；ExcelJS 等成熟库会用 instanceof
    // 识别数组。隔离由一次性 Utility Process 提供，常见 Node 全局在闭包中置空。
    const factory = new Function(
      'process', 'require', 'module', 'exports', 'global', 'globalThis', 'Buffer',
      `"use strict"; return (${source}\n)`,
    )
    value = factory(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      Object.freeze(Object.create(null)),
      undefined,
    )
  } catch (error) {
    throw new OfficeProcessingError('corrupted', `Office 构建脚本编译失败：${message(error)}`)
  }
  if (typeof value !== 'function') {
    throw new OfficeProcessingError('corrupted', 'Office 构建脚本必须是一个函数表达式')
  }
  return value as (context: Record<string, unknown>) => unknown | Promise<unknown>
}

async function serializeArtifact(format: OfficeFormat, artifact: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(artifact)) return artifact
  if (artifact instanceof Uint8Array) {
    return Buffer.from(artifact.buffer, artifact.byteOffset, artifact.byteLength)
  }
  try {
    if (format === 'docx') return Buffer.from(await docx.Packer.toBuffer(artifact as docx.Document))
    if (format === 'pptx' && isRecord(artifact) && typeof artifact.write === 'function') {
      return Buffer.from(await (artifact.write as (options: object) => Promise<Buffer>)({
        outputType: 'nodebuffer',
      }))
    }
    if (
      format === 'xlsx'
      && isRecord(artifact)
      && isRecord(artifact.xlsx)
      && typeof artifact.xlsx.writeBuffer === 'function'
    ) {
      const value = await (artifact.xlsx.writeBuffer as () => Promise<Buffer | ArrayBuffer>)()
      return Buffer.from(value as ArrayBuffer)
    }
  } catch (error) {
    throw new OfficeProcessingError('corrupted', `Office 构建结果序列化失败：${message(error)}`)
  }
  throw new OfficeProcessingError('corrupted', `构建函数没有返回可序列化的 ${format.toUpperCase()} 对象`)
}

function assetMediaType(extension: string): string {
  const values: Record<string, string> = {
    gif: 'image/gif', jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', svg: 'image/svg+xml',
    webp: 'image/webp', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }
  return values[extension] ?? 'application/octet-stream'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
