import { createTwoFilesPatch, FILE_HEADERS_ONLY } from 'diff'
import { CHECKPOINT_FILE_PREVIEW_MAX_BYTES } from '../../checkpoints/types.ts'

interface DiffFile { displayPath: string; original: string; updated: string }

export function makeDiff(files: readonly DiffFile[]): string {
  const parts: string[] = []
  const deadline = performance.now() + 300
  let remaining = 32 * 1024
  for (const { displayPath, original, updated } of files) {
    if (original === updated) continue
    const timeout = Math.ceil(deadline - performance.now())
    let preview: string
    if (remaining <= 0) preview = `${displayPath}（已达到差异预览长度上限）`
    else if (timeout <= 0) preview = `${displayPath}（差异计算超时，已省略预览）`
    else if (Buffer.byteLength(original) > CHECKPOINT_FILE_PREVIEW_MAX_BYTES || Buffer.byteLength(updated) > CHECKPOINT_FILE_PREVIEW_MAX_BYTES) {
      preview = `${displayPath}（文件超过 512 KiB，已省略差异预览）`
    } else {
      const patch = createTwoFilesPatch(displayPath, displayPath, original, updated, undefined, undefined, {
        context: 3, timeout, headerOptions: FILE_HEADERS_ONLY,
      })
      if (!patch) preview = `${displayPath}（差异计算超时，已省略预览）`
      else if (patch.length <= remaining) preview = patch.replace(/\n$/, '')
      else {
        const end = patch.lastIndexOf('\n', remaining)
        preview = (end > 0 ? patch.slice(0, end) : displayPath) + '\n[其余差异已省略]'
      }
    }
    parts.push(preview)
    remaining -= preview.length + 2
  }
  return parts.join('\n\n')
}
