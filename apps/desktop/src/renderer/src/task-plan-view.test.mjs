import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseHTML } from 'linkedom'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import { TaskPlanController } from '../../../../../packages/core/src/tasks/controller.ts'
import { createTaskPlanTools } from '../../../../../packages/core/src/tasks/tools.ts'

test('工具卡片原样显示回执，侧栏按新顺序编号并标记全部进行中项', async t => {
  const vite = await createServer({
    root: import.meta.dirname, configFile: false, esbuild: { jsx: 'automatic' },
    server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true },
  })
  t.after(() => vite.close())
  const { TaskPlanView } = await vite.ssrLoadModule('/task-plan-view.tsx')
  const { ToolCallDetails } = await vite.ssrLoadModule('/tool-call-details.tsx')
  const controller = new TaskPlanController()
  const tools = createTaskPlanTools(controller)
  async function run(name, input) {
    const result = await tools.find(tool => tool.name === name).execute(input, {})
    if (result.isError) controller.discardUpdate()
    else controller.commitUpdate()
    const call = { id: 'plan-tool', name, input, status: result.isError ? 'error' : 'done', progress: '', result: result.data }
    const html = renderToStaticMarkup(createElement(ToolCallDetails, { runtimeId: 'session', call }))
    const { document } = parseHTML(html)
    assert.equal(document.documentElement.textContent, result.data)
    return result
  }
  await run('CreateTaskPlan', { goal: '验收计划展示', items: [
    { kind: 'work', outcome: '解析数据', status: 'in_progress' },
    { kind: 'work', outcome: '适配调用方', status: 'in_progress' },
    { kind: 'verification', outcome: '通过验收' },
  ] })
  await run('UpdateTaskItem', { changes: [{ action: 'add', after_item_id: 'T1', outcome: '兼容旧配置' }] })
  const html = renderToStaticMarkup(createElement(TaskPlanView, { plan: controller.stateSnapshot.activePlan }))
  const { document } = parseHTML(html)
  assert.deepEqual([...document.querySelectorAll('li')].map(row => row.textContent),
    ['T1解析数据', 'T2兼容旧配置', 'T3适配调用方', 'T4通过验收验证'])
  assert.equal(document.querySelectorAll('[aria-label="进行中"]').length, 2)
  const missing = await run('UpdateTaskItem', { changes: [{ action: 'delete', item_id: 'T8' }] })
  assert.ok(missing.isError)
  assert.match(missing.data, /T2「兼容旧配置」、T3「适配调用方」/)
  assert.equal((await run('CloseTaskPlan', {})).data, '计划已按要求结束，已完成 0/4。')
})
