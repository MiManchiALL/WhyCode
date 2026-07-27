import { stemmer } from 'stemmer'
import {
  sameMcpCatalog,
  type McpCatalogTool,
} from './catalog.ts'

export const MCP_TOOL_SEARCH_DEFAULT_RESULTS = 5
export const MCP_TOOL_SEARCH_MAX_RESULTS = 8

const ENGLISH_ACTION_CANONICAL = new Map([
  ['get', 'read'],
  ['fetch', 'read'],
  ['retriev', 'read'],
  ['load', 'read'],
  ['show', 'read'],
  ['view', 'read'],
  ['brows', 'list'],
  ['enumer', 'list'],
  ['find', 'search'],
  ['queri', 'search'],
  ['lookup', 'search'],
  ['creat', 'create'],
  ['add', 'create'],
  ['write', 'create'],
  ['make', 'create'],
  ['updat', 'update'],
  ['edit', 'update'],
  ['modifi', 'update'],
  ['chang', 'update'],
  ['delet', 'delete'],
  ['remov', 'delete'],
])

interface IndexedDocument {
  tool: McpCatalogTool
  termFrequency: Map<string, number>
  length: number
}

export interface McpToolSearchMatch {
  tool: McpCatalogTool
  score: number
}

/**
 * 索引只包含目录已有事实，并以 descriptorHash 判定是否仍有效。
 * 工具目录未变化时可跨 ToolSearch 复用，目录变化则整体重建。
 */
export class McpToolSearchIndex {
  private readonly tools: readonly McpCatalogTool[]
  private readonly documents: readonly IndexedDocument[]
  private readonly documentFrequency = new Map<string, number>()
  private readonly averageLength: number

  constructor(tools: readonly McpCatalogTool[]) {
    this.tools = tools
    this.documents = tools.map(indexDocument)
    this.averageLength = this.documents.length === 0
      ? 0
      : this.documents.reduce((sum, document) => sum + document.length, 0)
        / this.documents.length
    for (const document of this.documents) {
      for (const term of document.termFrequency.keys()) {
        this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1)
      }
    }
  }

  matches(tools: readonly McpCatalogTool[]): boolean {
    return sameMcpCatalog(this.tools, tools)
  }

  search(
    query: string,
    maxResults = MCP_TOOL_SEARCH_DEFAULT_RESULTS,
  ): McpToolSearchMatch[] {
    const queryTerms = [...new Set(tokenize(query))]
    if (queryTerms.length === 0 || this.documents.length === 0) return []
    const normalizedQuery = query.normalize('NFKC').toLowerCase()
    return this.documents
      .map((document) => ({
        tool: document.tool,
        score: bm25Score(
          document,
          queryTerms,
          this.documentFrequency,
          this.documents.length,
          this.averageLength,
        ) + exactMatchBoost(document.tool, normalizedQuery),
      }))
      .filter((match) => match.score > 0)
      .sort((left, right) =>
        right.score - left.score
        || left.tool.exposedName.localeCompare(right.tool.exposedName))
      .slice(0, Math.min(Math.max(maxResults, 1), MCP_TOOL_SEARCH_MAX_RESULTS))
  }
}

export function searchMcpTools(
  tools: readonly McpCatalogTool[],
  query: string,
  maxResults = MCP_TOOL_SEARCH_DEFAULT_RESULTS,
): McpToolSearchMatch[] {
  return new McpToolSearchIndex(tools).search(query, maxResults)
}

/**
 * 英文/数字按词切分；中日韩文本同时产生单字与双字 token。
 * 英文使用 Porter 词干与通用动作归一，避免 files/file、read/get 分裂。
 */
export function tokenize(value: string, maxTokens = 4_000): string[] {
  const normalized = value
    .normalize('NFKC')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .toLowerCase()
  const tokens = normalized.match(/[a-z0-9]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)
    ?? []
  const result: string[] = []
  let cjkRun: string[] = []
  const flushCjk = () => {
    result.push(...cjkRun)
    for (let index = 0; index + 1 < cjkRun.length; index++) {
      result.push(`${cjkRun[index]}${cjkRun[index + 1]}`)
    }
    cjkRun = []
  }
  for (const token of tokens) {
    if (token.length === 1 && /[^\x00-\x7f]/u.test(token)) {
      cjkRun.push(token)
    } else {
      flushCjk()
      const stemmed = /^[a-z]+$/u.test(token) ? stemmer(token) : token
      result.push(ENGLISH_ACTION_CANONICAL.get(stemmed) ?? stemmed)
    }
  }
  flushCjk()
  return result.slice(0, maxTokens)
}

function indexDocument(tool: McpCatalogTool): IndexedDocument {
  const termFrequency = new Map<string, number>()
  let length = 0
  const addField = (value: string, weight: number, maxTerms: number) => {
    const terms = tokenize(value, maxTerms)
    length += terms.length
    for (const term of terms) {
      termFrequency.set(term, (termFrequency.get(term) ?? 0) + weight)
    }
  }
  const schema = schemaSearchFields(tool.inputSchema)
  addField(`${tool.serverName} ${tool.rawName}`, 4, 64)
  addField(tool.title, 3, 64)
  addField(tool.description, 1, 256)
  addField(schema.names, 2, 64)
  addField(schema.descriptions, 0.5, 128)
  return { tool, termFrequency, length: Math.max(length, 1) }
}

function bm25Score(
  document: IndexedDocument,
  queryTerms: readonly string[],
  documentFrequency: ReadonlyMap<string, number>,
  documentCount: number,
  averageLength: number,
): number {
  const k1 = 1.2
  const b = 0.75
  let score = 0
  for (const term of queryTerms) {
    const frequency = document.termFrequency.get(term) ?? 0
    if (frequency === 0) continue
    const containing = documentFrequency.get(term) ?? 0
    const inverseFrequency = Math.log(1 + (documentCount - containing + 0.5) / (containing + 0.5))
    const normalizedFrequency =
      frequency * (k1 + 1)
      / (frequency + k1 * (1 - b + b * document.length / Math.max(averageLength, 1)))
    score += inverseFrequency * normalizedFrequency
  }
  return score
}

function exactMatchBoost(tool: McpCatalogTool, query: string): number {
  if (!query) return 0
  const names = [tool.rawName, tool.title, tool.exposedName, tool.serverName]
    .map((value) => value.normalize('NFKC').toLowerCase())
  if (names.some((name) => name === query)) return 8
  if (names.some((name) => name.includes(query))) return 3
  return tool.description.normalize('NFKC').toLowerCase().includes(query) ? 1.5 : 0
}

function schemaSearchFields(
  schema: Record<string, unknown>,
): { names: string; descriptions: string } {
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const names: string[] = []
  const descriptions: string[] = []
  for (const [name, value] of Object.entries(properties).sort().slice(0, 40)) {
    names.push(name)
    if (!isRecord(value)) continue
    if (typeof value.description === 'string') {
      descriptions.push(value.description.slice(0, 500))
    }
  }
  return {
    names: names.join(' '),
    descriptions: descriptions.join(' '),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
