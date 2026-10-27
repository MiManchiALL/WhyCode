import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { tool, type ModelMessage } from 'ai'
import { z } from 'zod'
import { loadProjectInstructions } from '../instructions/project.ts'
import { buildSystemPrompt } from '../prompts/system.ts'
import { applySkillContext, skillCatalogMessage } from '../skills/context.ts'
import type { SkillTurnSnapshot } from '../skills/types.ts'
import { projectSubagentCatalog, subagentCatalogUpdate } from '../subagents/context.ts'
import { estimateMessagesTokens, estimateMessageTokens, estimateTextTokens } from './tokens.ts'
import { estimateMessageContextDetails, estimateRequestContextOverhead } from './usage.ts'

describe('上下文组成明细', () => {
  for (const mode of ['off', 'append', 'replace'] as const) {
    it(`按实际 System 统计 ${mode} 模式，不计被覆盖的内置部分`, async () => {
      const custom = mode === 'off' ? undefined : { mode, content: '用户追加的规则。' }
      const system = buildSystemPrompt({ projectDir: '/project', osPlatform: 'linux' }, custom)
      const usage = await estimateRequestContextOverhead(system, undefined, custom)
      assert.equal(usage.system.mode, mode)
      assert.equal(usage.systemPromptTokens, estimateTextTokens(system))
      assert.equal(usage.system.builtIn + usage.system.custom, usage.systemPromptTokens)
      assert.equal(usage.system.custom, custom ? estimateTextTokens(custom.content) : 0)
      assert.equal(usage.system.builtIn === 0, mode === 'replace')
    })
  }

  it('只统计工具数组中已加载的 MCP schema，ToolSearch 仍计入内置工具', async () => {
    const builtIn = {
      ToolSearch: tool({ description: '服务目录及检索说明', inputSchema: z.object({ query: z.string() }) }),
    }
    const mcp = {
      Mcp__example__lookup__12345678: tool({ description: '查找记录', inputSchema: z.object({ id: z.string() }) }),
    }
    const before = await estimateRequestContextOverhead('', builtIn)
    const loaded = await estimateRequestContextOverhead('', { ...builtIn, ...mcp })
    const mcpOnly = await estimateRequestContextOverhead('', mcp)
    assert.equal(before.tools.mcp, 0)
    assert.equal(loaded.tools.builtIn, before.toolTokens)
    assert.equal(loaded.tools.mcp, mcpOnly.toolTokens)
    assert.ok(loaded.tools.mcp > 0)
    assert.equal(loaded.toolTokens, loaded.tools.builtIn + loaded.tools.mcp)
  })

  it('三个顶部配置块独立计量，目录增量与其余消息保持在上下文', async t => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-usage-'))
    t.after(async () => {
      assert.equal(dirname(root), tmpdir())
      await rm(root, { recursive: true, force: true })
    })
    await writeFile(join(root, 'AGENTS.md'), '项目代码规范')
    const instructions = await loadProjectInstructions({ projectDir: root })
    assert.ok(instructions)
    const baseline = subagentCatalogUpdate([], { definitions: [], diagnostics: [] })!
    const delta = subagentCatalogUpdate([baseline], { definitions: [{
      name: 'review', description: '检查代码', scope: 'user', profile: 'reviewer',
      instructions: '不会发送给父模型的子代理正文', toolNames: ['ReadFile'],
    }], diagnostics: [] })!
    const catalog: SkillTurnSnapshot = {
      revision: 'sha256:test', modelContext: '<available_skills>测试目录</available_skills>',
      skills: [], entries: [], diagnostics: [], omittedCount: 0,
    }
    const user: ModelMessage = { role: 'user', content: [
      { type: 'text', text: '阅读附件' }, { type: 'image', image: 'data:image/png;base64,test' },
    ] }
    const messages = applySkillContext(projectSubagentCatalog([
      instructions.message, user, baseline, delta,
    ]), catalog, [], new Set())
    const details = estimateMessageContextDetails(messages)
    assert.equal(details.agents, estimateMessageTokens(instructions.message))
    assert.equal(details.subagents, estimateMessageTokens(baseline))
    assert.equal(details.skills, estimateMessageTokens(skillCatalogMessage(catalog)!))
    assert.equal(details.context, estimateMessageTokens(user) + estimateMessageTokens(delta))
    assert.equal(Object.values(details).reduce((sum, tokens) => sum + tokens, 0), estimateMessagesTokens(messages))

    const noPrefix = estimateMessageContextDetails([user, baseline, skillCatalogMessage(catalog)!])
    assert.deepEqual(noPrefix, { agents: 0, subagents: 0, skills: 0,
      context: estimateMessagesTokens([user, baseline, skillCatalogMessage(catalog)!]) })
  })
})
