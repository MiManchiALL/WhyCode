import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { extname } from 'node:path'
import JSZip, { type JSZipObject } from 'jszip'
import {
  OFFICE_ARTIFACT_MAX_SOURCE_BYTES,
  OfficeProcessingError,
  officeExtension,
  type OfficeFormat,
} from '@whycode/core/office'
import { requireValidXml } from './xml.ts'

const MAX_ARCHIVE_ENTRIES = 10_000
const MAX_ENTRY_BYTES = 100_000_000
const MAX_TOTAL_UNCOMPRESSED_BYTES = 500_000_000
const MAX_XML_BYTES = 64_000_000
const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

export interface OfficeArchive {
  format: OfficeFormat
  bytes: Buffer
  byteLength: number
  sha256: string
  zip: JSZip
  entrySizes: ReadonlyMap<string, number>
}

export async function openOfficeArchive(
  path: string,
  expectedFormat?: OfficeFormat,
): Promise<OfficeArchive> {
  const bytes = await readBoundedFile(path)
  const entrySizes = inspectZipDirectory(bytes)
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: false, createFolders: false })
  } catch (error) {
    throw new OfficeProcessingError('corrupted', 'Office 文件不是有效的 OOXML ZIP 包', {
      cause: error,
    })
  }
  const format = detectFormat(zip)
  if (expectedFormat && format !== expectedFormat) {
    throw new OfficeProcessingError(
      'corrupted',
      `构建结果实际是 ${format.toUpperCase()}，与请求的 ${expectedFormat.toUpperCase()} 不一致`,
    )
  }
  if (extname(path).toLowerCase() !== officeExtension(format)) {
    throw new OfficeProcessingError('unsupported', `文件扩展名必须是 ${officeExtension(format)}`)
  }
  if ([...entrySizes.keys()].some((name) => /(?:^|\/)vbaProject\.bin$/i.test(name))) {
    throw new OfficeProcessingError('unsupported', '当前只处理不含宏的 DOCX、PPTX 和 XLSX')
  }
  return {
    format,
    bytes,
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    zip,
    entrySizes,
  }
}

export async function readXml(archive: OfficeArchive, name: string): Promise<string> {
  const size = archive.entrySizes.get(name)
  const entry = archive.zip.file(name)
  if (!entry || size === undefined) {
    throw new OfficeProcessingError('corrupted', `Office 文件缺少必要部件：${name}`)
  }
  if (size > MAX_XML_BYTES) {
    throw new OfficeProcessingError('too-large', `OOXML 部件超过 ${MAX_XML_BYTES / 1_000_000} MB：${name}`)
  }
  let xml: string
  try {
    xml = await entry.async('string')
  } catch (error) {
    throw new OfficeProcessingError('corrupted', `无法解压 OOXML 部件：${name}`, { cause: error })
  }
  if (Buffer.byteLength(xml, 'utf8') > MAX_XML_BYTES) {
    throw new OfficeProcessingError('too-large', `OOXML 部件解压后超过安全上限：${name}`)
  }
  requireValidXml(xml, name)
  return xml
}

export function sortedEntries(zip: JSZip, pattern: RegExp): JSZipObject[] {
  return Object.values(zip.files)
    .filter((entry) => !entry.dir && pattern.test(entry.name))
    .sort((left, right) => numericName(left.name) - numericName(right.name))
}

function detectFormat(zip: JSZip): OfficeFormat {
  const candidates: OfficeFormat[] = []
  if (zip.file('word/document.xml')) candidates.push('docx')
  if (zip.file('ppt/presentation.xml')) candidates.push('pptx')
  if (zip.file('xl/workbook.xml')) candidates.push('xlsx')
  if (candidates.length !== 1 || !zip.file('[Content_Types].xml')) {
    throw new OfficeProcessingError('corrupted', 'Office 文件缺少唯一有效的 OOXML 主部件')
  }
  return candidates[0]!
}

async function readBoundedFile(path: string): Promise<Buffer> {
  const file = await open(path, 'r').catch((error) => {
    throw new OfficeProcessingError('unknown', `无法读取 Office 文件：${path}`, { cause: error })
  })
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new OfficeProcessingError('corrupted', 'Office 来源不是普通文件')
    if (info.size <= 0) throw new OfficeProcessingError('empty', 'Office 文件为空')
    if (info.size > OFFICE_ARTIFACT_MAX_SOURCE_BYTES) {
      throw new OfficeProcessingError('too-large', 'Office 文件超过 100 MB 上限')
    }
    const bytes = Buffer.alloc(Number(info.size))
    let offset = 0
    while (offset < bytes.byteLength) {
      const { bytesRead } = await file.read(bytes, offset, bytes.byteLength - offset, offset)
      if (bytesRead === 0) throw new OfficeProcessingError('corrupted', '读取时 Office 文件发生变化')
      offset += bytesRead
    }
    return bytes
  } finally {
    await file.close()
  }
}

function inspectZipDirectory(bytes: Buffer): ReadonlyMap<string, number> {
  const eocd = findEndOfCentralDirectory(bytes)
  const entryCount = bytes.readUInt16LE(eocd + 10)
  const entriesOnDisk = bytes.readUInt16LE(eocd + 8)
  const centralSize = bytes.readUInt32LE(eocd + 12)
  const centralOffset = bytes.readUInt32LE(eocd + 16)
  if (
    bytes.readUInt16LE(eocd + 4) !== 0
    || bytes.readUInt16LE(eocd + 6) !== 0
    || entriesOnDisk !== entryCount
  ) {
    throw new OfficeProcessingError('unsupported', '当前不处理多磁盘 Office ZIP')
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new OfficeProcessingError('too-large', '当前不处理 ZIP64 Office 文件')
  }
  if (entryCount <= 0 || entryCount > MAX_ARCHIVE_ENTRIES) {
    throw new OfficeProcessingError('too-large', `Office 包含的部件数量超过 ${MAX_ARCHIVE_ENTRIES}`)
  }
  if (centralOffset + centralSize > eocd || centralOffset < 0) {
    throw new OfficeProcessingError('corrupted', 'Office ZIP 中央目录越界')
  }

  const names = new Map<string, number>()
  let totalUncompressed = 0
  let cursor = centralOffset
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > eocd || bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new OfficeProcessingError('corrupted', 'Office ZIP 中央目录损坏')
    }
    const flags = bytes.readUInt16LE(cursor + 8)
    const method = bytes.readUInt16LE(cursor + 10)
    const compressedSize = bytes.readUInt32LE(cursor + 20)
    const uncompressedSize = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28)
    const extraLength = bytes.readUInt16LE(cursor + 30)
    const commentLength = bytes.readUInt16LE(cursor + 32)
    const next = cursor + 46 + nameLength + extraLength + commentLength
    if (next > eocd || nameLength === 0) {
      throw new OfficeProcessingError('corrupted', 'Office ZIP 部件名称损坏')
    }
    if ((flags & 0x1) !== 0) throw new OfficeProcessingError('unsupported', '不处理加密的 Office ZIP 部件')
    if (method !== 0 && method !== 8) throw new OfficeProcessingError('unsupported', 'Office ZIP 使用了不支持的压缩算法')
    if (compressedSize > OFFICE_ARTIFACT_MAX_SOURCE_BYTES || uncompressedSize > MAX_ENTRY_BYTES) {
      throw new OfficeProcessingError('too-large', 'Office ZIP 单个部件超过安全上限')
    }
    totalUncompressed += uncompressedSize
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new OfficeProcessingError('too-large', 'Office ZIP 解压后总大小超过安全上限')
    }
    let name: string
    try {
      name = UTF8_DECODER.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength))
    } catch (error) {
      throw new OfficeProcessingError('corrupted', 'Office ZIP 部件名称不是有效 UTF-8', {
        cause: error,
      })
    }
    requireSafeEntryName(name)
    const normalized = name.replaceAll('\\', '/')
    if (names.has(normalized)) throw new OfficeProcessingError('corrupted', `Office ZIP 部件重复：${normalized}`)
    names.set(normalized, uncompressedSize)
    cursor = next
  }
  if (cursor !== centralOffset + centralSize) {
    throw new OfficeProcessingError('corrupted', 'Office ZIP 中央目录长度不一致')
  }
  return names
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const minimum = Math.max(0, bytes.length - 65_557)
  for (let offset = bytes.length - 22; offset >= minimum; offset--) {
    if (bytes.readUInt32LE(offset) !== EOCD_SIGNATURE) continue
    const commentLength = bytes.readUInt16LE(offset + 20)
    if (offset + 22 + commentLength === bytes.length) return offset
  }
  throw new OfficeProcessingError('corrupted', 'Office 文件缺少 ZIP 结束目录')
}

function requireSafeEntryName(name: string): void {
  const normalized = name.replaceAll('\\', '/')
  const parts = normalized.split('/')
  if (
    name.includes('\0')
    || normalized.startsWith('/')
    || /^[A-Za-z]:/.test(normalized)
    || parts.some((part, index) => !part && index < parts.length - 1)
    || parts.some((part) => part === '.' || part === '..')
  ) {
    throw new OfficeProcessingError('corrupted', 'Office ZIP 含不安全的部件路径')
  }
}

function numericName(name: string): number {
  const value = /([0-9]+)(?=\.[^.]+$)/.exec(name)?.[1]
  return value ? Number(value) : Number.MAX_SAFE_INTEGER
}
