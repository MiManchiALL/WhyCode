import { extname } from 'node:path'
import { z } from 'zod'
import {
  OFFICE_ARTIFACT_MAX_ASSETS,
  officeExtension,
  officeFormatSchema,
  type OfficeArtifactRunner,
} from '../../office/types.ts'
import { buildTool } from '../tool.ts'
import { resolveAllowed } from '../fs-utils.ts'
import {
  BUILD_OFFICE_ARTIFACT_PROMPT,
  BUILD_OFFICE_ARTIFACT_TOOL_NAME,
} from './prompt.ts'

export { BUILD_OFFICE_ARTIFACT_TOOL_NAME } from './prompt.ts'

const assetSchema = z.object({
  key: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
    .describe('脚本读取资源时使用的稳定 key'),
  path: z.string().min(1).describe('项目内或已授权的资源路径'),
})

const inputSchema = z.object({
  format: officeFormatSchema.describe('输出格式'),
  scriptPath: z.string().min(1).describe('受限 JavaScript 构建函数文件路径'),
  outputPath: z.string().min(1).describe('最终 DOCX/PPTX/XLSX 输出路径'),
  assets: z.array(assetSchema).max(OFFICE_ARTIFACT_MAX_ASSETS).default([])
    .describe('构建脚本可读取的图片、模板或其它输入资源'),
}).superRefine((input, ctx) => {
  const expected = officeExtension(input.format)
  if (extname(input.outputPath).toLowerCase() !== expected) {
    ctx.addIssue({
      code: 'custom',
      path: ['outputPath'],
      message: `输出扩展名必须是 ${expected}`,
    })
  }
  const keys = new Set<string>()
  input.assets.forEach((asset, index) => {
    if (keys.has(asset.key)) {
      ctx.addIssue({ code: 'custom', path: ['assets', index, 'key'], message: '资源 key 不能重复' })
    }
    keys.add(asset.key)
  })
})

export function createBuildOfficeArtifactTool(runner: OfficeArtifactRunner) {
  return buildTool({
    name: BUILD_OFFICE_ARTIFACT_TOOL_NAME,
    description: '隔离生成并校验 DOCX、PPTX 或 XLSX 文件',
    prompt: BUILD_OFFICE_ARTIFACT_PROMPT,
    inputSchema,
    isReadOnly: false,
    kind: 'execute',
    extractPaths: (input) => [
      input.scriptPath,
      input.outputPath,
      ...input.assets.map((asset) => asset.path),
    ],
    checkpointScope: (input, ctx) => ({
      kind: 'exact-files',
      paths: [resolveAllowed(ctx, input.outputPath)],
    }),
    async execute(input, ctx) {
      const result = await runner.build({
        format: input.format,
        scriptPath: resolveAllowed(ctx, input.scriptPath),
        outputPath: resolveAllowed(ctx, input.outputPath),
        assets: input.assets.map((asset) => ({
          key: asset.key,
          path: resolveAllowed(ctx, asset.path),
        })),
      }, ctx.abortSignal, ctx.onProgress)
      const { inspection } = result
      return {
        data: [
          `已生成并通过 OOXML 结构校验：${result.outputPath}`,
          `格式 ${inspection.format.toUpperCase()}；${formatBytes(inspection.byteLength)}；SHA-256 ${inspection.sha256}`,
          `结构单元 ${inspection.unitCount} 个；公式 ${inspection.formulaCount} 个；已发现公式错误值 ${inspection.formulaErrorCount} 个。`,
          '下一步：调用 InspectOffice 核对内容；当前模型支持视觉时，再调用 RenderOffice 检查全部渲染页。',
        ].join('\n'),
        isError: false,
      }
    },
  })
}

function formatBytes(bytes: number): string {
  return bytes < 1_000_000
    ? `${(bytes / 1_000).toFixed(1)} KB`
    : `${(bytes / 1_000_000).toFixed(2)} MB`
}
