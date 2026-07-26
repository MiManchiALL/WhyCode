import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import {
  loadMcpConfiguration,
  type McpManagerSnapshot,
} from '@whycode/core'
import {
  addMcpConfiguredServer,
  createMcpSettingsSnapshot,
  enableMcpPreset,
  updateMcpSecretHeader,
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
        mcpSecretHeaders: [],
      })
      assert.equal(snapshot.currentSessionUsesSnapshot, true)
      assert.deepEqual(snapshot.servers, [
        {
          name: 'shared',
          scope: 'global',
          transport: 'http',
          enabled: true,
          effective: false,
          secretHeaderNames: [],
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
          secretHeaderNames: [],
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
        mcpSecretHeaders: [],
      })
      assert.equal(before.recommendedPresets[0]?.status, 'available')

      await enableMcpPreset(globalConfigPath, { presetId: 'context7' })
      let snapshot = await createMcpSettingsSnapshot({
        globalConfigPath,
        projectDir: null,
        currentSessionSnapshot: null,
        mcpSecretHeaders: [],
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
        mcpSecretHeaders: [],
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
        mcpSecretHeaders: [],
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

  it('简化表单复用通用配置写入，并只向 Renderer 暴露安全密钥状态', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-mcp-editor-'))
    const globalConfigPath = join(root, 'mcp.json')
    try {
      await addMcpConfiguredServer(
        { globalConfigPath, projectDir: null },
        {
          scope: 'global',
          name: 'docs',
          server: { transport: 'http', url: 'https://docs.example/mcp' },
        },
      )
      const discovered = await loadMcpConfiguration({ globalConfigPath })
      const fingerprint = discovered.configuredServers[0]?.connectionFingerprint
      assert.ok(fingerprint)

      const config = await updateMcpSecretHeader(
        { globalConfigPath, projectDir: null },
        { providers: {} },
        {
          scope: 'global',
          serverName: 'docs',
          headerName: 'X-API-Key',
          secret: 'safe-secret',
        },
      )
      assert.deepEqual(config.mcpSecretHeaders, [{
        serverName: 'docs',
        connectionFingerprint: fingerprint,
        headerName: 'X-API-Key',
        value: 'safe-secret',
      }])

      const snapshot = await createMcpSettingsSnapshot({
        globalConfigPath,
        projectDir: null,
        currentSessionSnapshot: null,
        mcpSecretHeaders: config.mcpSecretHeaders ?? [],
      })
      assert.deepEqual(snapshot.servers[0]?.secretHeaderNames, ['X-API-Key'])
      assert.doesNotMatch(
        JSON.stringify(snapshot),
        /safe-secret|docs\.example|connectionFingerprint/u,
      )

      const effective = await loadMcpConfiguration({
        globalConfigPath,
        globalSecretHeaders: config.mcpSecretHeaders,
      })
      const server = effective.servers[0]
      assert.equal(server?.transport, 'http')
      if (server?.transport !== 'http') assert.fail('应解析为 HTTP MCP')
      assert.equal(server.headers['X-API-Key'], 'safe-secret')

      await addMcpConfiguredServer(
        { globalConfigPath, projectDir: null },
        {
          scope: 'global',
          name: 'local',
          server: {
            transport: 'stdio',
            command: ' node ',
            args: [' -y ', ' ', '@example/mcp'],
            cwd: ' tools ',
          },
        },
      )
      const stored = JSON.parse(await readFile(globalConfigPath, 'utf8'))
      assert.deepEqual(stored.servers.local, {
        transport: 'stdio',
        command: 'node',
        args: ['-y', '@example/mcp'],
        cwd: 'tools',
        enabled: true,
      })

      const cleared = await updateMcpSecretHeader(
        { globalConfigPath, projectDir: null },
        config,
        {
          scope: 'global',
          serverName: 'docs',
          headerName: 'x-api-key',
          clearSecret: true,
        },
      )
      assert.equal(cleared.mcpSecretHeaders, undefined)

      await assert.rejects(
        updateMcpSecretHeader(
          { globalConfigPath, projectDir: root },
          config,
          {
            scope: 'project',
            serverName: 'docs',
            headerName: 'X-API-Key',
            secret: 'project-secret',
          },
        ),
        /项目 MCP/,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function writeConfig(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
