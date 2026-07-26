import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import {
  MCP_GLOBAL_CONFIG_TEMPLATE,
  MCP_PROJECT_CONFIG_TEMPLATE,
  MCP_CONTEXT7_PRESET,
  addMcpServer,
  ensureMcpConfigTemplate,
  ensureProjectMcpConfigTemplate,
  loadMcpConfiguration,
  setMcpServerEnabled,
} from './config.ts'

describe('MCP 配置', () => {
  it('只在文件缺失时创建关闭状态模板，不覆盖已有内容', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-mcp-config-'))
    const path = join(root, '.whycode', 'mcp.json')
    const projectPath = join(root, 'project', '.whycode', 'mcp.json')
    try {
      await ensureMcpConfigTemplate(path)
      assert.equal(await readFile(path, 'utf8'), MCP_GLOBAL_CONFIG_TEMPLATE)
      assert.deepEqual(JSON.parse(MCP_GLOBAL_CONFIG_TEMPLATE), {
        version: 1,
        servers: {
          context7: {
            transport: 'http',
            url: MCP_CONTEXT7_PRESET.server.url,
            enabled: false,
          },
        },
      })
      await ensureProjectMcpConfigTemplate(projectPath)
      assert.equal(await readFile(projectPath, 'utf8'), MCP_PROJECT_CONFIG_TEMPLATE)
      assert.deepEqual(JSON.parse(MCP_PROJECT_CONFIG_TEMPLATE), {
        version: 1,
        servers: {},
      })
      await writeFile(path, '{"owned":true}\n', 'utf8')
      await ensureMcpConfigTemplate(path)
      assert.equal(await readFile(path, 'utf8'), '{"owned":true}\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('项目条目按完整服务器覆盖全局条目，禁用或无效时不会回退', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-mcp-override-'))
    const globalPath = join(root, 'global.json')
    const projectDir = join(root, 'project')
    const projectPath = join(projectDir, '.whycode', 'mcp.json')
    try {
      await ensureMcpConfigTemplate(projectPath)
      await writeConfig(globalPath, {
        version: 1,
        servers: {
          shared: { transport: 'stdio', command: 'global-command' },
        },
      })
      await writeConfig(projectPath, {
        version: 1,
        servers: {
          shared: {
            transport: 'http',
            url: 'https://example.com/mcp',
            headers: { Authorization: 'Bearer ${MISSING_TOKEN}' },
          },
        },
      })
      const loaded = await loadMcpConfiguration({
        globalConfigPath: globalPath,
        projectDir,
        env: {},
      })
      assert.deepEqual(loaded.servers, [])
      assert.equal(loaded.projectServerCount, 0)
      assert.match(loaded.diagnostics[0]?.message ?? '', /MISSING_TOKEN/)

      await writeConfig(projectPath, {
        version: 1,
        servers: {
          shared: { transport: 'http', url: 'https://example.com/mcp', enabled: false },
        },
      })
      const disabled = await loadMcpConfiguration({
        globalConfigPath: globalPath,
        projectDir,
      })
      assert.deepEqual(disabled.servers, [])
      assert.deepEqual(disabled.configuredServers, [
        {
          name: 'shared',
          scope: 'global',
          transport: 'stdio',
          enabled: true,
          effective: false,
        },
        {
          name: 'shared',
          scope: 'project',
          transport: 'http',
          enabled: false,
          effective: true,
        },
      ])

      await writeConfig(projectPath, {
        version: 1,
        servers: {
          shared: { transport: 'stdio', command: 'project-command', unknown: true },
        },
      })
      const invalid = await loadMcpConfiguration({
        globalConfigPath: globalPath,
        projectDir,
      })
      assert.deepEqual(invalid.servers, [])
      assert.match(invalid.diagnostics[0]?.message ?? '', /配置格式无效/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('环境变量只在受支持字段展开，相对 cwd 按配置作用域解析', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-mcp-env-'))
    const globalPath = join(root, 'global.json')
    try {
      await writeConfig(globalPath, {
        version: 1,
        servers: {
          local: {
            transport: 'stdio',
            command: 'node',
            cwd: 'server',
            env: { API_TOKEN: '${TEST_MCP_TOKEN}' },
          },
        },
      })
      const loaded = await loadMcpConfiguration({
        globalConfigPath: globalPath,
        env: { TEST_MCP_TOKEN: 'secret' },
      })
      assert.equal(loaded.servers.length, 1)
      const server = loaded.servers[0]!
      assert.equal(server.transport, 'stdio')
      if (server.transport !== 'stdio') assert.fail('应解析为 stdio')
      assert.equal(server.cwd, join(root, 'server'))
      assert.equal(server.env.API_TOKEN, 'secret')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('损坏 JSON 的诊断不回显可能邻近语法错误的配置密钥', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-mcp-invalid-json-'))
    const globalPath = join(root, 'global.json')
    try {
      await writeFile(
        globalPath,
        '{"version":1,"servers":{"remote":{"transport":"http","url":"https://example.com/mcp","headers":{"Authorization":"Bearer must-not-leak"}}},}',
        'utf8',
      )
      const loaded = await loadMcpConfiguration({ globalConfigPath: globalPath })
      assert.deepEqual(loaded.servers, [])
      assert.equal(loaded.diagnostics[0]?.message, '配置不是合法 JSON')
      assert.doesNotMatch(JSON.stringify(loaded.diagnostics), /must-not-leak/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('启停只修改目标条目，推荐预设只在名称空闲时原子加入', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-mcp-mutation-'))
    const globalPath = join(root, 'mcp.json')
    try {
      await writeConfig(globalPath, {
        version: 1,
        servers: {
          custom: {
            transport: 'http',
            url: 'https://example.com/mcp',
            headers: { Authorization: 'Bearer ${CUSTOM_TOKEN}' },
          },
        },
      })
      await setMcpServerEnabled(globalPath, 'custom', false)
      await addMcpServer(globalPath, MCP_CONTEXT7_PRESET.name, {
        ...MCP_CONTEXT7_PRESET.server,
        enabled: true,
      })
      const stored = JSON.parse(await readFile(globalPath, 'utf8'))
      assert.deepEqual(stored, {
        version: 1,
        servers: {
          custom: {
            transport: 'http',
            url: 'https://example.com/mcp',
            headers: { Authorization: 'Bearer ${CUSTOM_TOKEN}' },
            enabled: false,
          },
          context7: {
            transport: 'http',
            url: MCP_CONTEXT7_PRESET.server.url,
            enabled: true,
          },
        },
      })
      await assert.rejects(
        addMcpServer(globalPath, MCP_CONTEXT7_PRESET.name, MCP_CONTEXT7_PRESET.server),
        /名称已存在/,
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
