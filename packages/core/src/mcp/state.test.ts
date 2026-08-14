import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  carryMcpToolState,
  clearMcpProjectTrust,
  createMcpToolStateMessage,
  findMcpToolState,
} from './state.ts'

describe('MCP 会话状态', () => {
  it('按稳定顺序保存服务器说明，并限制说明总字节数', () => {
    const message = createMcpToolStateMessage({
      tools: [],
      trustedProjectConfigurationFingerprint: null,
      serverInstructions: ['echo', 'delta', 'alpha', 'charlie', 'bravo'].map(
        (serverName, index) => ({
          serverName,
          runtimeFingerprint: String(index + 1).repeat(64),
          instructions: `${serverName}:${'x'.repeat(1_800)}`,
        }),
      ),
    })
    const state = findMcpToolState([message])
    assert.deepEqual(
      state.serverInstructions.map((snapshot) => snapshot.serverName),
      ['alpha', 'bravo', 'charlie', 'delta', 'echo'],
    )
    assert.equal(
      state.serverInstructions.reduce(
        (total, snapshot) =>
          total + Buffer.byteLength(snapshot.instructions, 'utf8'),
        0,
      ) <= 8 * 1024,
      true,
    )
    assert.match(
      state.serverInstructions.at(-1)?.instructions ?? '',
      /\[服务器初始化说明已按会话总上限截断\]/u,
    )
  })

  it('压缩后只携带压缩前的最新工具与服务器说明状态', () => {
    const old = createMcpToolStateMessage({
      tools: [],
      trustedProjectConfigurationFingerprint: null,
      serverInstructions: [{
        serverName: 'old',
        runtimeFingerprint: 'a'.repeat(64),
        instructions: '旧说明',
      }],
    })
    const latest = createMcpToolStateMessage({
      tools: [],
      trustedProjectConfigurationFingerprint: 'c'.repeat(64),
      serverInstructions: [{
        serverName: 'current',
        runtimeFingerprint: 'b'.repeat(64),
        instructions: '当前说明',
      }],
    })
    const compacted = carryMcpToolState(
      [old, { role: 'user', content: '问题' }, latest],
      [{ role: 'user', content: '压缩摘要' }, old],
    )

    assert.equal(
      compacted.filter((message) =>
        typeof message.content === 'string'
        && message.content.includes('whycode-mcp-tool-state')).length,
      1,
    )
    assert.equal(findMcpToolState(compacted).serverInstructions[0]?.serverName, 'current')
    assert.equal(
      findMcpToolState(compacted).trustedProjectConfigurationFingerprint,
      'c'.repeat(64),
    )
  })

  it('Fork 只清除项目配置信任，不丢失已发现工具和服务器说明', () => {
    const stateMessage = createMcpToolStateMessage({
      tools: [{
        id: 'a'.repeat(64),
        descriptorHash: 'b'.repeat(64),
        serverName: 'project-server',
      }],
      trustedProjectConfigurationFingerprint: 'c'.repeat(64),
      serverInstructions: [{
        serverName: 'project-server',
        runtimeFingerprint: 'd'.repeat(64),
        instructions: '服务器说明',
      }],
    })

    const forked = clearMcpProjectTrust([
      { role: 'user', content: '继续处理' },
      stateMessage,
    ])
    const state = findMcpToolState(forked)
    assert.equal(state.trustedProjectConfigurationFingerprint, null)
    assert.equal(state.tools[0]?.serverName, 'project-server')
    assert.equal(state.serverInstructions[0]?.instructions, '服务器说明')
  })
})
