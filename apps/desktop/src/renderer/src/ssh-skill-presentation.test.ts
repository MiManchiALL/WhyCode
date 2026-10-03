import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SshSkillJob, SshSkillRow } from '../../shared/ssh-skills.ts'
import { canSyncSkill, sshSkillItems } from './ssh-skill-presentation.ts'

const row = (id: string, status: SshSkillRow['status'] = 'same'): SshSkillRow => ({ id, name: id, description: '', status, local: true, managed: status !== 'missing', modified: false })
const job = (operation: SshSkillJob['operation'], id: string, ok = true): SshSkillJob => ({ operation, running: false, total: 1, results: [{ id, name: id, ok, message: ok ? operation === 'sync' ? '已同步' : '已清理' : '连接中断' }] })

describe('SSH Skill 管理列表结果', () => {
  it('普通列表沿用同步和清理的筛选边界', () => {
    const rows = [row('same'), row('missing', 'missing'), { ...row('remote', 'remote-only'), local: false }]
    assert.deepEqual(sshSkillItems(rows, undefined, 'sync', true).map(item => item.id), ['same', 'missing'])
    assert.deepEqual(sshSkillItems(rows, undefined, 'sync', false).map(item => item.id), ['missing'])
    assert.deepEqual(sshSkillItems(rows, undefined, 'clean', true).map(item => item.id), ['same', 'remote'])
  })

  it('隐藏已有项时，刚同步成功的结果仍留在对应条目内', () => {
    const completed = job('sync', 'updated')
    const items = sshSkillItems([row('same'), row('updated'), row('missing', 'missing')], completed, 'sync', false)
    assert.deepEqual(items.map(item => item.id), ['updated', 'missing'])
    assert.equal(items[0]!.result, completed.results[0])
    assert.equal(canSyncSkill(items[0]!.row!), false)
  })

  it('清理后的本地项和已消失的远端副本都保留结果，但不作为可清理目录', () => {
    const completed = job('clean', 'remote')
    completed.results.push({ id: 'local', name: 'local', ok: true, message: '已清理' })
    completed.total = 2
    const items = sshSkillItems([row('local', 'missing')], completed, 'clean', true)
    assert.deepEqual(items.map(item => item.id), ['local', 'remote'])
    assert.equal(items[0]!.row?.managed, false)
    assert.equal(items[1]!.row, undefined)
    assert.equal(items[1]!.result, completed.results[0])
  })

  it('失败原因在筛选或切换模式后仍可读，下一任务替换旧结果', () => {
    const failed = job('sync', 'removed', false)
    const items = sshSkillItems([], failed, 'clean', true)
    assert.equal(items[0]!.result?.message, '连接中断')
    assert.equal(items[0]!.result?.ok, false)
    assert.deepEqual(sshSkillItems([], job('clean', 'next'), 'clean', true).map(item => item.id), ['next'])
    assert.deepEqual(sshSkillItems([], undefined, 'clean', true), [])
  })
})
