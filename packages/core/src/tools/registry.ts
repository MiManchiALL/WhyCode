import type { ToolDefinition } from './tool.ts'
import { readFileTool } from './read-file/index.ts'
import { listDirTool, globTool } from './list-glob/index.ts'
import { grepTool } from './grep/index.ts'
import { writeFileTool, editFileTool } from './write-edit/index.ts'
import { runCommandTool } from './run-command/index.ts'
import { batchEditTool } from './batch-edit/index.ts'
import { deleteFileTool, moveFileTool } from './file-lifecycle/index.ts'

/** M1 内置工具集。M2 起权限规则、M3 起按讨论/执行阶段过滤都作用在这份列表上。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const BUILTIN_TOOLS: readonly ToolDefinition<any>[] = [
  readFileTool,
  listDirTool,
  globTool,
  grepTool,
  writeFileTool,
  editFileTool,
  batchEditTool,
  deleteFileTool,
  moveFileTool,
  runCommandTool,
]
