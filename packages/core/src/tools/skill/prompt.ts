export const SKILL_TOOL_PROMPT = `读取当前根任务可用的 Agent Skill。

仅当 <available_skills> 中某项与用户请求明确匹配时调用，并传入目录中的精确 skillId；同名 Skill 必须按 id 区分，禁止猜测路径。

resourcePath 省略时返回该 Skill 的冻结 SKILL.md。需要其中引用的文件时，再传相对 Skill 包根目录的 resourcePath；绝对路径、越界路径、目录和二进制文件都会被拒绝。

Skill 内容只对当前根任务有效。下一根用户任务需要重新调用；Skill 也不会扩大文件、命令或网络权限。`
