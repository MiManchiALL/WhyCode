import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import type { McpManagerSnapshot } from '@whycode/core'
import {
  createMcpSettingsSnapshot,
  enableMcpPreset,
  updateMcpServerState,
} from './mcp-settings.ts'

describe('MCP 连接设置', () => {
  it('合并配置作用域与当前会话状态，但不把连接密钥送入 Renderer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-mcp-settings-'))
    const globalConfigPath = join(root, 'home', 'mcp.json')
    const projectDir = join(root, 'project')
    const projectConfigPath = join(projectDir, '.whycode', 'mcp.json')
    try {
      await writeConfig(globalConfigPath, {
        version: 1,
        servers: {
          shared: {
            transport: 'http',
            url: 'https://global.example/mcp',
            headers: { Authorization: 'Bearer top-secret-value' },
          },
        },
      })
      await writeConfig(projectConfigPath, {
        version: 1,
        servers: {
          shared: {
            transport: 'stdio',
            command: 'node',
            enabled: false,
          },
        },
      })
      const currentSessionSnapshot: McpManagerSnapshot = {
        tools: [],
        configDiagnostics: [],
        servers: [{
          name: 'shared',
          scope: 'global',
          state: 'ready',
          toolCount: 3,
          diagnostics: [],
        }],
      }
      const snapshot = await createMcpSettingsSnapshot({
        globalConfigPath,
        projectDir,
        currentSessionSnapshot,
      })
      assert.equal(snapshot.currentSessionUsesSnapshot, true)
      assert.deepEqual(snapshot.servers, [
        {
          name: 'shared',
          scope: 'global',
          transport: 'http',
          enabled: true,
          effective: false,
          currentSessionState: 'ready',
          currentSessionToolCount: 3,
          currentSessionDiagnostics: [],
        },
        {
          name: 'shared',
          scope: 'project',
          transport: 'stdio',
          enabled: false,
          effective: true,
          currentSessionDiagnostics: [],
        },
      ])
      assert.doesNotMatch(JSON.stringify(snapshot), /top-secret-value|global\.example/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('推荐 Context7 写入全局单一事实源，已有条目由通用开关管理', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-mcp-preset-'))
    const globalConfigPath = join(root, 'mcp.json')
    try {
      const before = await createMcpSettingsSnapshot({
        globalConfigPath,
        projectDir: null,
        currentSessionSnapshot: null,
      })
      assert.equal(before.recommendedPresets[0]?.status, 'available')

      await enableMcpPreset(globalConfigPath, { presetId: 'context7' })
      let snapshot = await createMcpSettingsSnapshot({
        globalConfigPath,
        projectDir: null,
        currentSessionSnapshot: null,
      })
      assert.equal(snapshot.recommendedPresets[0]?.status, 'installed')
      assert.equal(snapshot.servers[0]?.enabled, true)

      await updateMcpServerState(
        { globalConfigPath, projectDir: null },
        { scope: 'global', name: 'context7', enabled: false },
      )
      snapshot = await createMcpSettingsSnapshot({
        globalConfigPath,
        projectDir: null,
        currentSessionSnapshot: null,
      })
      assert.equal(snapshot.servers[0]?.enabled, false)
      const stored = JSON.parse(await readFile(globalConfigPath, 'utf8'))
      assert.equal(stored.servers.context7.enabled, false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('不把同名自定义服务器冒充或覆盖为 Context7 预置', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-mcp-preset-conflict-'))
    const globalConfigPath = join(root, 'mcp.json')
    try {
      await writeConfig(globalConfigPath, {
        version: 1,
        servers: {
          context7: {
            transport: 'http',
            url: 'https://custom.example/mcp',
          },
        },
      })
      const snapshot = await createMcpSettingsSnapshot({
        globalConfigPath,
        projectDir: null,
        currentSessionSnapshot: null,
      })
      assert.equal(snapshot.recommendedPresets[0]?.status, 'name-conflict')
      await assert.rejects(
        enableMcpPreset(globalConfigPath, { presetId: 'context7' }),
        /名称已存在/,
      )
      const stored = JSON.parse(await readFile(globalConfigPath, 'utf8'))
      assert.equal(stored.servers.context7.url, 'https://custom.example/mcp')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function writeConfig(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
