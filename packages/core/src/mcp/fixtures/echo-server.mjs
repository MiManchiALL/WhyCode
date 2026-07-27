import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'whycode-test', version: '1.0.0' })
let lateToolRegistered = false

server.registerTool(
  'echo_text',
  {
    description: 'Echoes supplied text for deterministic integration tests',
    inputSchema: {
      text: z.string().describe('Text to echo'),
    },
  },
  async ({ text }) => ({
    content: [{ type: 'text', text: `echo:${text}` }],
    structuredContent: { echoed: text },
  }),
)

server.registerTool(
  'change_catalog',
  {
    description: 'Changes the test tool catalog by registering a late tool',
    inputSchema: {},
  },
  async () => {
    if (!lateToolRegistered) {
      lateToolRegistered = true
      server.registerTool(
        'late_tool',
        {
          description: 'A tool registered after the initial catalog was loaded',
          inputSchema: {},
        },
        async () => ({ content: [{ type: 'text', text: 'late' }] }),
      )
    }
    return { content: [{ type: 'text', text: 'catalog changed' }] }
  },
)

await server.connect(new StdioServerTransport())
