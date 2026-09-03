import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  parseRightPanelWidthRatio,
  parseRightPanelWidthPreference,
  projectRightPanelDrag,
  rightPanelRatioFromWidth,
  rightPanelWidthBounds,
  rightPanelWidthExpression,
} from './right-panel-layout.ts'

describe('右侧栏宽度布局', () => {
  it('使用窗口比例保存宽度并收敛损坏的持久值', () => {
    assert.equal(parseRightPanelWidthRatio(null), 0.4)
    assert.equal(parseRightPanelWidthRatio(''), 0.4)
    assert.equal(parseRightPanelWidthRatio('not-a-number'), 0.4)
    assert.equal(parseRightPanelWidthRatio('0.12'), 0.2)
    assert.equal(parseRightPanelWidthRatio('0.56'), 0.56)
    assert.equal(parseRightPanelWidthRatio('1.2'), 0.9)
    assert.deepEqual(parseRightPanelWidthPreference('0.56', null), {
      ratio: 0.56,
      maximumRatio: 0.56,
    })
    assert.deepEqual(parseRightPanelWidthPreference('0.36', '0.56'), {
      ratio: 0.36,
      maximumRatio: 0.56,
    })
    assert.deepEqual(parseRightPanelWidthPreference('0.72', '0.56'), {
      ratio: 0.56,
      maximumRatio: 0.56,
    })
    assert.equal(rightPanelRatioFromWidth(768, 1_920), 0.4)
    assert.equal(
      rightPanelWidthExpression(0.4, 0.56),
      'min(40vw, max(0px, calc(100% - 420px)))',
    )
    assert.equal(
      rightPanelWidthExpression(0.72, 0.56),
      'min(56vw, max(0px, calc(100% - 420px)))',
    )
  })

  it('向左扩展不超过首次保存的最大宽度', () => {
    assert.deepEqual(rightPanelWidthBounds({
      viewportWidth: 1_920,
      containerWidth: 1_660,
      maximumRatio: 0.6,
    }), {
      minWidth: 384,
      maxWidth: 1_152,
    })

    const expanded = projectRightPanelDrag({
      startX: 1_152,
      pointerX: 800,
      startWidth: 768,
      viewportWidth: 1_920,
      containerWidth: 1_660,
      maximumRatio: 0.6,
      collapsed: false,
    })
    assert.equal(expanded.width, 1_120)
    assert.equal(expanded.shouldCollapse, false)

    const limited = projectRightPanelDrag({
      startX: 1_152,
      pointerX: 0,
      startWidth: 768,
      viewportWidth: 1_920,
      containerWidth: 1_660,
      maximumRatio: 0.6,
      collapsed: false,
    })
    assert.equal(limited.width, 1_152)
    assert.equal(limited.shouldCollapse, false)
  })

  it('最大偏好较宽时仍给对话区保留最低宽度', () => {
    assert.deepEqual(rightPanelWidthBounds({
      viewportWidth: 1_920,
      containerWidth: 1_660,
      maximumRatio: 0.9,
    }), {
      minWidth: 384,
      maxWidth: 1_240,
    })
  })

  it('向右越过最小宽度后收起，并在按住时向左返回同一阈值后展开', () => {
    const heldAtMinimum = projectRightPanelDrag({
      startX: 1_152,
      pointerX: 1_570,
      startWidth: 768,
      viewportWidth: 1_920,
      containerWidth: 1_660,
      maximumRatio: 0.6,
      collapsed: false,
    })
    assert.equal(heldAtMinimum.width, 384)
    assert.equal(heldAtMinimum.shouldCollapse, false)

    const collapsed = projectRightPanelDrag({
      startX: 1_152,
      pointerX: 1_608,
      startWidth: 768,
      viewportWidth: 1_920,
      containerWidth: 1_660,
      maximumRatio: 0.6,
      collapsed: false,
    })
    assert.equal(collapsed.width, 384)
    assert.equal(collapsed.shouldCollapse, true)

    const heldCollapsed = projectRightPanelDrag({
      startX: 1_152,
      pointerX: 1_568,
      startWidth: 768,
      viewportWidth: 1_920,
      containerWidth: 1_660,
      maximumRatio: 0.6,
      collapsed: true,
    })
    assert.equal(heldCollapsed.width, 384)
    assert.equal(heldCollapsed.shouldCollapse, true)

    const reopened = projectRightPanelDrag({
      startX: 1_152,
      pointerX: 1_536,
      startWidth: 768,
      viewportWidth: 1_920,
      containerWidth: 1_660,
      maximumRatio: 0.6,
      collapsed: true,
    })
    assert.equal(reopened.width, 384)
    assert.equal(reopened.shouldCollapse, false)
  })

  it('窗口过窄时优先保留对话区且不产生负宽度', () => {
    assert.deepEqual(rightPanelWidthBounds({
      viewportWidth: 800,
      containerWidth: 520,
      maximumRatio: 0.6,
    }), {
      minWidth: 100,
      maxWidth: 100,
    })
  })
})
