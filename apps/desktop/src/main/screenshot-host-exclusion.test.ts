import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  captureWithHostExcluded,
  type ScreenshotHostWindow,
} from './screenshot-host-exclusion.ts'

describe('截图宿主窗口排除', () => {
  it('Windows 内容保护在采集期间排除宿主，并恢复原状态', async () => {
    const state = createWindowState({ focused: false })

    const captured = await captureWithHostExcluded(state.window, {
      mode: 'content-protection',
      capture: async () => {
        state.calls.push(`capture:${state.contentProtected}`)
        return 'image'
      },
    })

    assert.deepEqual(captured, { result: 'image', hostExcluded: true })
    assert.deepEqual(state.calls, ['protect:true', 'capture:true', 'protect:false'])
    assert.equal(state.contentProtected, false)
  })

  it('采集失败也恢复内容保护，既有保护状态则保持不变', async () => {
    const unprotected = createWindowState()
    await assert.rejects(
      captureWithHostExcluded(unprotected.window, {
        mode: 'content-protection',
        capture: async () => {
          throw new Error('capture failed')
        },
      }),
      /capture failed/,
    )
    assert.equal(unprotected.contentProtected, false)

    const protectedState = createWindowState({ protected: true })
    const captured = await captureWithHostExcluded(protectedState.window, {
      mode: 'content-protection',
      capture: async () => 'image',
    })
    assert.equal(captured.hostExcluded, true)
    assert.equal(protectedState.contentProtected, true)
    assert.deepEqual(protectedState.calls, [])
  })

  it('非 Windows 只在宿主处于前台时隐藏，并在异常后恢复显示', async () => {
    const focused = createWindowState()
    await assert.rejects(
      captureWithHostExcluded(focused.window, {
        mode: 'hide-focused',
        settleAfterHide: async () => {
          focused.calls.push('settled')
        },
        capture: async () => {
          focused.calls.push('capture')
          throw new Error('capture failed')
        },
      }),
      /capture failed/,
    )
    assert.deepEqual(focused.calls, ['hide', 'settled', 'capture', 'show'])

    const background = createWindowState({ focused: false })
    const captured = await captureWithHostExcluded(background.window, {
      mode: 'hide-focused',
      capture: async () => 'image',
    })
    assert.deepEqual(captured, { result: 'image', hostExcluded: false })
    assert.deepEqual(background.calls, [])
  })
})

function createWindowState(initial: { focused?: boolean; protected?: boolean } = {}) {
  const state = {
    calls: [] as string[],
    destroyed: false,
    visible: true,
    focused: initial.focused ?? true,
    contentProtected: initial.protected ?? false,
  }
  const window: ScreenshotHostWindow = {
    isDestroyed: () => state.destroyed,
    isVisible: () => state.visible,
    isFocused: () => state.focused,
    isContentProtected: () => state.contentProtected,
    setContentProtection: (enabled) => {
      state.contentProtected = enabled
      state.calls.push(`protect:${enabled}`)
    },
    hide: () => {
      state.visible = false
      state.focused = false
      state.calls.push('hide')
    },
    show: () => {
      state.visible = true
      state.focused = true
      state.calls.push('show')
    },
  }
  return Object.assign(state, { window })
}
