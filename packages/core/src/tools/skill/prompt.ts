export const SKILL_TOOL_PROMPT = `使用 Skill 执行任务时，必须通过本工具加载并激活 SKILL.md；读取或使用其配套资源前，须确保该 Skill 在当前任务中处于激活状态。

仅当 <available_skills> 中某项与用户请求明确匹配时调用，并传入目录中的精确 skillId；同名 Skill 必须按 id 区分，禁止猜测路径。

配套资源按 Skill 指引选用合适的工具。本工具省略 resourcePath 时返回冻结的 SKILL.md，读取包内文本可传相对 Skill 包根目录的 resourcePath；拒绝绝对路径、越界路径、目录和二进制文件。

Skill 不扩大文件、命令或网络权限。`
