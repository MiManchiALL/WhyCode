import { z } from 'zod'
import { buildTool, type ToolContext } from '../tool.ts'
import { LOAD_WORKSPACE_DEPENDENCIES_PROMPT } from './prompt.ts'

export const LOAD_WORKSPACE_DEPENDENCIES_TOOL_NAME = 'LoadWorkspaceDependencies'

export function createLoadWorkspaceDependenciesTool(load: (context: ToolContext) => Promise<unknown>) {
  return buildTool({
    name: LOAD_WORKSPACE_DEPENDENCIES_TOOL_NAME,
    description: '准备当前工作环境的依赖并返回运行路径',
    prompt: LOAD_WORKSPACE_DEPENDENCIES_PROMPT,
    inputSchema: z.object({}).strict(), isReadOnly: false, kind: 'execute',
    async execute(_input, context) {
      try { return { data: JSON.stringify(await load(context)), isError: false } }
      catch (error) { return { data: error instanceof Error ? error.message : String(error), isError: true } }
    },
  })
}
