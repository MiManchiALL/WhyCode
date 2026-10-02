import { readFile, stat } from 'node:fs/promises'
import { extname, posix, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import JSZip from 'jszip'
import { XMLParser, XMLValidator } from 'fast-xml-parser'

const parser = new XMLParser({ ignoreAttributes: false, transformTagName: name => name.split(':').at(-1), parseTagValue: false, processEntities: true })
const array = value => value === undefined ? [] : Array.isArray(value) ? value : [value]
const text = value => typeof value === 'string' ? value : value?.['#text'] ?? ''
const relationId = node => Object.entries(node).find(([name]) => /^@_.+:id$/.test(name))?.[1]

function collect(node, key) {
  if (!node || typeof node !== 'object') return []
  return Object.entries(node).flatMap(([name, value]) => name === key ? array(value) : array(value).flatMap(child => collect(child, key)))
}

async function openPackage(path) {
  const info = await stat(path)
  if (!info.isFile() || info.size > 100 * 1024 * 1024) throw new Error('Office input must be a regular file up to 100 MiB')
  const zip = await JSZip.loadAsync(await readFile(path))
  const files = Object.values(zip.files).filter(entry => !entry.dir)
  if (files.length > 10000) throw new Error('Office ZIP contains more than 10000 entries')
  let size = 0
  const xml = new Map()
  for (const entry of files) {
    const original = entry.unsafeOriginalName ?? entry.name
    if (original !== entry.name || original.startsWith('/') || original.includes('\\') || original.split('/').includes('..')) throw new Error('Office ZIP contains an unsafe entry')
    size += entry._data.uncompressedSize
    if (size > 128 * 1024 * 1024) throw new Error('Office ZIP expands beyond 128 MiB')
  }
  for (const entry of files.filter(entry => /\.(xml|rels)$/.test(entry.name))) {
    if (entry._data.uncompressedSize > 16 * 1024 * 1024) throw new Error(`XML part exceeds 16 MiB: ${entry.name}`)
    const raw = await entry.async('string')
    if (/<!DOCTYPE|<!ENTITY/i.test(raw) || XMLValidator.validate(raw) !== true) throw new Error(`Invalid XML: ${entry.name}`)
    xml.set(entry.name, parser.parse(raw))
  }
  if (!xml.has('[Content_Types].xml') || !xml.has('_rels/.rels')) throw new Error('Missing Office package metadata')
  const relationships = new Map()
  let externalLinks = 0
  for (const [part, document] of xml) {
    if (!part.endsWith('.rels')) continue
    const base = part === '_rels/.rels' ? '' : posix.dirname(posix.dirname(part))
    const links = new Map()
    for (const relation of array(document.Relationships?.Relationship)) {
      if (relation['@_TargetMode'] === 'External') { externalLinks++; continue }
      const target = relation['@_Target']
      if (typeof target !== 'string') throw new Error(`Relationship has no target: ${part}`)
      const decoded = decodeURIComponent(target.split('#')[0])
      const resolved = posix.normalize(decoded.startsWith('/') ? decoded.slice(1) : posix.join(base, decoded))
      if (resolved.startsWith('../') || !zip.file(resolved)) throw new Error(`Missing relationship target: ${part} → ${resolved}`)
      links.set(relation['@_Id'], { path: resolved, type: relation['@_Type'] })
    }
    relationships.set(part, links)
  }
  return { xml, relationships, externalLinks }
}

/** Deterministic structure/content checks; appearance and business logic require task-specific review. */
export async function checkOffice(path, options = {}) {
  const format = extname(path).slice(1).toLowerCase()
  if (!['docx', 'pptx', 'xlsx'].includes(format)) throw new Error('Supported inputs: DOCX, PPTX, XLSX')
  const { xml, relationships, externalLinks } = await openPackage(path)
  const units = []
  let allText = ''
  let formulaCount = 0
  let missingFormulaResults = 0
  let formulaErrors = 0
  const errors = []
  const include = unit => { units.push(unit); allText += `${unit.text}\n` }
  if (format === 'docx') {
    const main = xml.get('word/document.xml')
    if (!main?.document?.body) throw new Error('Missing Word document body')
    const parts = ['word/document.xml']
    for (const relation of relationships.get('word/_rels/document.xml.rels')?.values() ?? []) {
      if (/(header|footer|footnotes|endnotes)$/.test(relation.type)) parts.push(relation.path)
    }
    for (const part of parts) for (const paragraph of collect(xml.get(part), 'p')) {
      include({ part, text: collect(paragraph, 't').map(text).join('') })
    }
  } else if (format === 'pptx') {
    const slides = array(xml.get('ppt/presentation.xml')?.presentation?.sldIdLst?.sldId)
    if (!slides.length) throw new Error('Missing presentation slides')
    for (const [index, slide] of slides.entries()) {
      const part = relationships.get('ppt/_rels/presentation.xml.rels')?.get(relationId(slide))?.path
      if (!part || !xml.has(part)) throw new Error('Slide relationship is missing')
      include({ slide: index + 1, part, text: collect(xml.get(part), 't').map(text).join('\n') })
    }
  } else {
    const strings = array(xml.get('xl/sharedStrings.xml')?.sst?.si).map(si => collect(si, 't').map(text).join(''))
    const sheets = array(xml.get('xl/workbook.xml')?.workbook?.sheets?.sheet)
    if (!sheets.length) throw new Error('Missing workbook sheets')
    for (const sheet of sheets) {
      const name = sheet['@_name']
      const part = relationships.get('xl/_rels/workbook.xml.rels')?.get(relationId(sheet))?.path
      if (!part || !xml.has(part)) throw new Error(`Missing worksheet: ${name}`)
      const cells = collect(xml.get(part)?.worksheet?.sheetData, 'c')
      const preview = []
      let previewSize = 0
      for (const cell of cells) {
        const formula = cell.f === undefined ? undefined : text(cell.f)
        const raw = text(cell.v)
        const value = cell['@_t'] === 's' ? strings[Number(raw)] : cell['@_t'] === 'inlineStr' ? collect(cell.is, 't').map(text).join('') : raw
        if (formula !== undefined) { formulaCount++; if (cell.v === undefined || (raw === '' && cell['@_t'] !== 'str')) missingFormulaResults++ }
        if (cell['@_t'] === 'e') formulaErrors++
        allText += `${name}!${cell['@_r']}: ${value ?? ''}\n`
        if ((!options.sheet || name === options.sheet) && preview.length < 200 && previewSize < 28000) {
          const item = { cell: cell['@_r'], value: String(value ?? '').slice(0, 512), ...(formula === undefined ? {} : { formula: formula.slice(0, 512) }) }
          preview.push(item); previewSize += JSON.stringify(item).length
        }
      }
      units.push({ sheet: name, part, cellCount: cells.length, cells: preview, cellsTruncated: preview.length < cells.length })
      allText += `${name}\n`
    }
    if (options.sheet && !sheets.some(sheet => sheet['@_name'] === options.sheet)) errors.push(`Worksheet not found: ${options.sheet}`)
    if (options.requireCalculated) {
      if (missingFormulaResults) errors.push(`${missingFormulaResults} formulas have no saved result`)
      if (formulaErrors) errors.push(`${formulaErrors} cells contain formula errors`)
      if ([...xml.keys()].some(part => part.startsWith('xl/externalLinks/'))) errors.push('External workbook links cannot be certified as recalculated')
    }
  }
  for (const required of options.contains ?? []) if (!allText.includes(required)) errors.push(`Required text not found: ${required}`)
  if (options.count !== undefined && units.length !== options.count) errors.push(`Expected ${options.count} units, found ${units.length}`)
  const offset = options.offset ?? 0
  const limit = options.limit ?? 20
  const page = []
  let chars = 0
  for (const unit of units.slice(offset, offset + limit)) {
    const bounded = 'text' in unit ? { ...unit, text: unit.text.slice(0, 20000), textTruncated: unit.text.length > 20000 } : unit
    const size = JSON.stringify(bounded).length
    if (chars + size > 60000) break
    page.push(bounded); chars += size
  }
  return { ok: errors.length === 0, format, unitCount: units.length, externalLinks,
    ...(format === 'xlsx' ? { formulaCount, missingFormulaResults, formulaErrors } : {}),
    units: page, nextOffset: offset + page.length < units.length ? offset + page.length : null, errors }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      contains: { type: 'string', multiple: true }, count: { type: 'string' }, sheet: { type: 'string' },
      offset: { type: 'string', default: '0' }, limit: { type: 'string', default: '20' }, 'require-calculated': { type: 'boolean' },
    } })
    if (positionals.length !== 1) throw new Error('Usage: check.mjs FILE [--contains TEXT] [--count N] [--sheet NAME] [--offset N --limit N] [--require-calculated]')
    const offset = Number(values.offset), limit = Number(values.limit), count = values.count === undefined ? undefined : Number(values.count)
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50 || (count !== undefined && (!Number.isInteger(count) || count < 0))) throw new Error('Invalid count, offset or limit')
    const report = await checkOffice(resolve(positionals[0]), { contains: values.contains, count, sheet: values.sheet, offset, limit, requireCalculated: values['require-calculated'] })
    console.log(JSON.stringify(report)); if (!report.ok) process.exitCode = 1
  } catch (error) { console.log(JSON.stringify({ ok: false, errors: [error.message] })); process.exitCode = 1 }
}
