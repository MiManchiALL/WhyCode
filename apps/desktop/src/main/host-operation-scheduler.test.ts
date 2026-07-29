import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { HostOperationScheduler } from './host-operation-scheduler.ts'

describe('HostOperationScheduler', () => {
  it('同一项目写入串行，不同项目可以并行', async () => {
    const scheduler = new HostOperationScheduler()
    const signal = new AbortController().signal
    let sameProjectActive = 0
    let sameProjectMax = 0
    let globalActive = 0
    let globalMax = 0
    const run = (project: string) => scheduler.runProjectWrite(project, signal, async () => {
      sameProjectActive++
      sameProjectMax = Math.max(sameProjectMax, sameProjectActive)
      globalActive++
      globalMax = Math.max(globalMax, globalActive)
      await delay(25)
      globalActive--
      sameProjectActive--
    })

    await Promise.all([
      run('C:\\workspace\\same'),
      run('C:\\workspace\\same'),
      scheduler.runProjectWrite('C:\\workspace\\other', signal, async () => {
        globalActive++
        globalMax = Math.max(globalMax, globalActive)
        await delay(25)
        globalActive--
      }),
    ])

    assert.equal(sameProjectMax, 1)
    assert.equal(globalMax >= 2, true)
  })

  it('等待期间取消后不执行副作用', async () => {
    const scheduler = new HostOperationScheduler()
    const firstSignal = new AbortController().signal
    const secondAbort = new AbortController()
    let release!: () => void
    const first = scheduler.runScreenshot(firstSignal, () =>
      new Promise<void>((resolve) => { release = resolve }))
    let executed = false
    const second = scheduler.runScreenshot(secondAbort.signal, async () => {
      executed = true
    })
    await delay(0)
    secondAbort.abort()

    await assert.rejects(second, { name: 'AbortError' })
    assert.equal(executed, false)
    release()
    await first
  })
})

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
