import { extname } from 'node:path'
import { z } from 'zod'
import {
  OFFICE_ARTIFACT_MAX_ASSETS,
  officeArtifactBuildModeSchema,
  officeExtension,
  officeFormatSchema,
  pptxTemplateRequirementsSchema,
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
  mode: officeArtifactBuildModeSchema.describe('从零创建用 create；编辑已有文件或套用指定模板用 template'),
  scriptPath: z.string().min(1).describe('受限 JavaScript 构建函数文件路径'),
  outputPath: z.string().min(1).describe('最终 DOCX/PPTX/XLSX 输出路径'),
  assets: z.array(assetSchema).max(OFFICE_ARTIFACT_MAX_ASSETS).default([])
    .describe('构建脚本可读取的图片、模板或其它输入资源'),
  templateAssetKey: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).optional()
    .describe('template 模式必须指定的原件 assets key'),
  pptxTemplateRequirements: pptxTemplateRequirementsSchema.optional()
    .describe('PPTX 模板任务按用户要求声明的附加校验；省略时只检查文件结构，设计效果另做视觉复核'),
}).superRefine((input, ctx) => {
  if (input.pptxTemplateRequirements && (input.format !== 'pptx' || input.mode !== 'template')) {
    ctx.addIssue({ code: 'custom', path: ['pptxTemplateRequirements'], message: '仅 PPTX template 模式可声明模板要求' })
  }
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
  if (input.mode === 'template' && !input.templateAssetKey) {
    ctx.addIssue({
      code: 'custom',
      path: ['templateAssetKey'],
      message: 'template 模式必须指定 templateAssetKey',
    })
  }
  if (input.mode === 'create' && input.templateAssetKey) {
    ctx.addIssue({
      code: 'custom',
      path: ['templateAssetKey'],
      message: 'create 模式不能指定 templateAssetKey',
    })
  }
  if (input.templateAssetKey && !keys.has(input.templateAssetKey)) {
    ctx.addIssue({
      code: 'custom',
      path: ['templateAssetKey'],
      message: 'templateAssetKey 必须对应一个 assets key',
    })
  }
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
        mode: input.mode,
        scriptPath: resolveAllowed(ctx, input.scriptPath),
        outputPath: resolveAllowed(ctx, input.outputPath),
        assets: input.assets.map((asset) => ({
          key: asset.key,
          path: resolveAllowed(ctx, asset.path),
        })),
        ...(input.templateAssetKey ? { templateAssetKey: input.templateAssetKey } : {}),
        ...(input.pptxTemplateRequirements ? { pptxTemplateRequirements: input.pptxTemplateRequirements } : {}),
      }, ctx.abortSignal, ctx.onProgress)
      const { inspection } = result
      return {
        data: [
          `已生成并通过 OOXML 结构校验：${result.outputPath}`,
          `格式 ${inspection.format.toUpperCase()}；${formatBytes(inspection.byteLength)}；SHA-256 ${inspection.sha256}`,
          `结构单元 ${inspection.unitCount} 个；公式 ${inspection.formulaCount} 个；未保存计算值 ${inspection.formulaUncalculatedCount} 个；公式错误值 ${inspection.formulaErrorCount} 个。`,
          ...(result.recalculation
            ? [`实际重算：${result.recalculation.engine === 'microsoft-excel' ? 'Microsoft Excel' : 'LibreOffice'}，${result.recalculation.formulaCount} 个公式已重算、保存并重新检查。`]
            : []),
          ...(result.template && input.format !== 'pptx'
            ? [`模板继承：${result.template.protectedPartCount} 个共享版式/媒体部件全部原样保留；新增 ${result.template.addedPartCount}、删除 ${result.template.removedPartCount} 个包部件。`]
            : []),
          ...(result.template && input.format === 'pptx'
            ? [
              `模板校验：${result.template.checks.length ? result.template.checks.join('；') : '未声明附加模板约束，源文件与成品已通过 OOXML 结构校验'}。`,
              '这些检查不证明模板视觉效果合格；还需对照用户要求核对 Logo、配色、字体、版式和内容适配。',
            ]
            : []),
          `深层校验覆盖 ${inspection.validation.checkedPartCount} 个 XML/关系部件与 ${inspection.validation.relationshipCount} 条关系。`,
          '下一步：调用 InspectOffice 核对内容；当前模型支持视觉时，先用 RenderOffice overview 检查整套，再用 pages 检查全部页面。',
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
