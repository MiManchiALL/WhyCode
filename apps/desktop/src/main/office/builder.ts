import { randomUUID } from 'node:crypto'
import {
  mkdtemp,
  open,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import {
  OFFICE_ARTIFACT_MAX_ASSET_BYTES,
  OFFICE_ARTIFACT_MAX_ASSETS,
  OFFICE_ARTIFACT_MAX_TOTAL_ASSET_BYTES,
  OFFICE_BUILDER_MAX_SCRIPT_BYTES,
  OfficeProcessingError,
  officeExtension,
  type OfficeArtifactBuildRequest,
  type OfficeArtifactBuildResult,
  type OfficeArtifactRunner,
} from '@whycode/core/office'
import { publishVerifiedFile } from './publisher.ts'
import { recalculateXlsx } from './recalculate-xlsx.ts'
import { finalizeOfficeBuild, type OfficeBuildFinalizerDependencies } from './finalize-build.ts'
import { runOfficeWorker } from './worker-client.ts'

const BUILD_TIMEOUT_MS = 180_000
const ASSET_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

const FINALIZER_DEPENDENCIES: OfficeBuildFinalizerDependencies = {
  recalculate: recalculateXlsx,
  publish: publishVerifiedFile,
  inspect: inspectStagedFile,
  compareTemplate: compareStagedTemplate,
}

export class ElectronOfficeArtifactRunner implements OfficeArtifactRunner {
  async build(
    request: OfficeArtifactBuildRequest,
    abortSignal: AbortSignal,
    onProgress?: (output: string) => void,
  ): Promise<OfficeArtifactBuildResult> {
    validateRequest(request)
    const stagingDirectory = await mkdtemp(join(tmpdir(), 'whycode-office-build-'))
    try {
      const { scriptPath, outputPath, assets } = await stageBuildInputs(request, stagingDirectory)
      const templateAsset = request.templateAssetKey
        ? assets.find((asset) => asset.key === request.templateAssetKey)
        : undefined
      if (templateAsset) {
        const templateInspection = await inspectStagedFile(templateAsset.path, abortSignal)
        if (templateInspection.format !== request.format) {
          throw new OfficeProcessingError(
            'unsupported',
            `模板格式 ${templateInspection.format.toUpperCase()} 与输出格式 ${request.format.toUpperCase()} 不一致`,
          )
        }
        onProgress?.(`已验证 ${request.format.toUpperCase()} 模板，开始沿用原结构构建`)
      }
      const result = await runOfficeWorker({
        id: randomUUID(),
        operation: 'build',
        format: request.format,
        scriptPath,
        outputPath,
        assets,
      }, abortSignal, BUILD_TIMEOUT_MS, 512)
      if (result.operation !== 'build') {
        throw new OfficeProcessingError('unknown', 'Office 构建返回了错误的操作结果')
      }
      result.progress.forEach((line) => onProgress?.(line))
      // Finalization still reads staged files; it must settle before the finally cleanup.
      const finalized = await finalizeOfficeBuild({
        format: request.format,
        stagedPath: outputPath,
        recalculatedPath: join(stagingDirectory, 'recalculated.xlsx'),
        targetPath: request.outputPath,
        ...(templateAsset ? { templatePath: templateAsset.path } : {}),
        workingDirectory: stagingDirectory,
        inspection: result.inspection,
        abortSignal,
        onProgress,
      }, FINALIZER_DEPENDENCIES)
      return finalized
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {})
    }
  }
}

async function stageBuildInputs(
  request: OfficeArtifactBuildRequest,
  stagingDirectory: string,
) {
  const scriptPath = join(stagingDirectory, 'builder.js')
  const outputPath = join(stagingDirectory, `artifact${officeExtension(request.format)}`)
  await stageRegularFile(request.scriptPath, scriptPath, OFFICE_BUILDER_MAX_SCRIPT_BYTES)
  const assets: { key: string; path: string }[] = []
  let totalAssetBytes = 0
  for (const [index, asset] of request.assets.entries()) {
    const extension = extname(asset.path).toLowerCase().slice(0, 24)
    const assetPath = join(stagingDirectory, `asset-${String(index).padStart(2, '0')}${extension}`)
    totalAssetBytes += await stageRegularFile(
      asset.path,
      assetPath,
      OFFICE_ARTIFACT_MAX_ASSET_BYTES,
    )
    if (totalAssetBytes > OFFICE_ARTIFACT_MAX_TOTAL_ASSET_BYTES) {
      throw new OfficeProcessingError('too-large', 'Office 构建资源总大小超过 150 MB')
    }
    assets.push({ key: asset.key, path: assetPath })
  }
  return { scriptPath, outputPath, assets }
}

async function inspectStagedFile(path: string, abortSignal: AbortSignal) {
  const result = await runOfficeWorker({
    id: randomUUID(),
    operation: 'inspect',
    path,
    options: { startUnit: 1, unitCount: 20, view: 'content' },
  }, abortSignal, BUILD_TIMEOUT_MS, 384)
  if (result.operation !== 'inspect') {
    throw new OfficeProcessingError('unknown', 'Office 构建结果检查返回了错误的操作结果')
  }
  return result.inspection
}

async function compareStagedTemplate(options: {
  templatePath: string
  outputPath: string
  format: OfficeArtifactBuildRequest['format']
  abortSignal: AbortSignal
}) {
  const result = await runOfficeWorker({
    id: randomUUID(),
    operation: 'compare-template',
    format: options.format,
    templatePath: options.templatePath,
    outputPath: options.outputPath,
  }, options.abortSignal, BUILD_TIMEOUT_MS, 384)
  if (result.operation !== 'compare-template') {
    throw new OfficeProcessingError('unknown', 'Office 模板比较返回了错误的操作结果')
  }
  return result.template
}

function validateRequest(request: OfficeArtifactBuildRequest): void {
  if (extname(request.outputPath).toLowerCase() !== officeExtension(request.format)) {
    throw new OfficeProcessingError(
      'unsupported',
      `输出扩展名必须是 ${officeExtension(request.format)}`,
    )
  }
  if (request.assets.length > OFFICE_ARTIFACT_MAX_ASSETS) {
    throw new OfficeProcessingError('too-large', `Office 构建资源最多 ${OFFICE_ARTIFACT_MAX_ASSETS} 个`)
  }
  const keys = new Set<string>()
  for (const asset of request.assets) {
    if (!ASSET_KEY.test(asset.key) || keys.has(asset.key)) {
      throw new OfficeProcessingError('corrupted', `Office 构建资源 key 无效或重复：${asset.key}`)
    }
    keys.add(asset.key)
  }
  if (request.mode === 'template' && !request.templateAssetKey) {
    throw new OfficeProcessingError('corrupted', 'template 模式必须指定 templateAssetKey')
  }
  if (request.mode === 'create' && request.templateAssetKey) {
    throw new OfficeProcessingError('corrupted', 'create 模式不能指定 templateAssetKey')
  }
  if (request.templateAssetKey && !keys.has(request.templateAssetKey)) {
    throw new OfficeProcessingError(
      'corrupted',
      `templateAssetKey 没有对应资源：${request.templateAssetKey}`,
    )
  }
}

async function stageRegularFile(source: string, target: string, maxBytes: number): Promise<number> {
  const file = await open(source, 'r').catch((error) => {
    throw new OfficeProcessingError('unknown', `无法读取构建输入：${source}`, { cause: error })
  })
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size <= 0) {
      throw new OfficeProcessingError('empty', `Office 构建输入不是非空普通文件：${source}`)
    }
    if (info.size > maxBytes) {
      throw new OfficeProcessingError('too-large', `Office 构建输入超过大小上限：${source}`)
    }
    const bytes = await file.readFile()
    if (bytes.byteLength !== info.size) {
      throw new OfficeProcessingError('corrupted', `Office 构建输入在读取时发生变化：${source}`)
    }
    await writeFile(target, bytes, { flag: 'wx', mode: 0o600, flush: true })
    return bytes.byteLength
  } finally {
    await file.close()
  }
}
