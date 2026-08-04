import {
  OfficeProcessingError,
  type OfficeArtifactBuildResult,
  type OfficeTemplateComparison,
  type OfficeFormat,
  type OfficeInspection,
} from '@whycode/core/office'

export interface OfficeBuildFinalizerDependencies {
  recalculate(options: {
    sourcePath: string
    outputPath: string
    workingDirectory: string
    abortSignal: AbortSignal
  }): Promise<'microsoft-excel' | 'libreoffice'>
  inspect(path: string, abortSignal: AbortSignal): Promise<OfficeInspection>
  compareTemplate(options: {
    templatePath: string
    outputPath: string
    format: OfficeFormat
    abortSignal: AbortSignal
  }): Promise<OfficeTemplateComparison>
  publish(source: string, target: string, sha256: string): Promise<void>
}

export async function finalizeOfficeBuild(options: {
  format: OfficeFormat
  stagedPath: string
  recalculatedPath: string
  targetPath: string
  templatePath?: string
  workingDirectory: string
  inspection: OfficeInspection
  abortSignal: AbortSignal
  onProgress?: (output: string) => void
}, dependencies: OfficeBuildFinalizerDependencies): Promise<OfficeArtifactBuildResult> {
  let publishPath = options.stagedPath
  let inspection = options.inspection
  let recalculation: OfficeArtifactBuildResult['recalculation']
  if (options.format === 'xlsx' && inspection.formulaCount > 0) {
    requireSupportedRecalculation(inspection)
    options.onProgress?.(`正在用实际公式引擎重算 ${inspection.formulaCount} 个公式`)
    const engine = await dependencies.recalculate({
      sourcePath: options.stagedPath,
      outputPath: options.recalculatedPath,
      workingDirectory: options.workingDirectory,
      abortSignal: options.abortSignal,
    })
    const recalculatedInspection = await dependencies.inspect(
      options.recalculatedPath,
      options.abortSignal,
    )
    requireSuccessfulRecalculation(inspection.formulaCount, recalculatedInspection)
    inspection = recalculatedInspection
    publishPath = options.recalculatedPath
    recalculation = { engine, formulaCount: inspection.formulaCount }
    options.onProgress?.(`XLSX 公式已由 ${engine === 'microsoft-excel' ? 'Microsoft Excel' : 'LibreOffice'} 重算并复核`)
  }
  const template = options.templatePath
    ? await dependencies.compareTemplate({
      templatePath: options.templatePath,
      outputPath: publishPath,
      format: options.format,
      abortSignal: options.abortSignal,
    })
    : undefined
  await dependencies.publish(publishPath, options.targetPath, inspection.sha256)
  return {
    outputPath: options.targetPath,
    inspection,
    ...(recalculation ? { recalculation } : {}),
    ...(template ? { template } : {}),
  }
}

function requireSupportedRecalculation(inspection: OfficeInspection): void {
  if (inspection.validation.issues.some((issue) => issue.code === 'xlsx-external-workbook')) {
    throw new OfficeProcessingError(
      'unsupported',
      'XLSX 公式引用外部工作簿；后台重算会禁用链接更新，因此不发布无法证明已刷新的结果',
    )
  }
}

function requireSuccessfulRecalculation(
  expectedFormulaCount: number,
  inspection: OfficeInspection,
): void {
  if (inspection.formulaCount !== expectedFormulaCount) {
    throw new OfficeProcessingError(
      'corrupted',
      `XLSX 重算前后公式数量不一致：${expectedFormulaCount} → ${inspection.formulaCount}`,
    )
  }
  if (inspection.formulaUncalculatedCount > 0) {
    throw new OfficeProcessingError(
      'corrupted',
      `XLSX 重算后仍有 ${inspection.formulaUncalculatedCount} 个公式没有已保存结果`,
    )
  }
  if (inspection.formulaErrorCount > 0) {
    throw new OfficeProcessingError(
      'corrupted',
      `XLSX 重算后仍有 ${inspection.formulaErrorCount} 个公式错误值`,
    )
  }
}
