import { createHash } from 'node:crypto'

const REPEATED_IDENTICAL_CALL_LIMIT = 3

/** 只拦截连续得到相同结果的完全相同调用；不同文件、参数或结果都会立即清零。 */
export class LoopHealthMonitor {
  private lastFingerprint: string | null = null
  private repeated = 0
  private pauseReason: string | null = null

  record(toolName: string, input: unknown, result: unknown, isError: boolean): void {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ toolName, input, result, isError }))
      .digest('hex')
    if (fingerprint === this.lastFingerprint) {
      this.repeated++
    } else {
      this.lastFingerprint = fingerprint
      this.repeated = 1
    }
    if (this.repeated >= REPEATED_IDENTICAL_CALL_LIMIT) {
      this.pauseReason = `${toolName} 使用相同参数连续得到相同结果 ${this.repeated} 次，疑似原地循环。`
    }
  }

  consumePauseReason(): string | null {
    const reason = this.pauseReason
    this.pauseReason = null
    return reason
  }
}
