# WhyCode Agent 与协议契约

> 本文是模型可见内容与跨层协议的权威说明：负责 System、内部消息、结构化输出、工具参数、上下文压缩、TaskPlan、多 Agent 和持久化边界。架构机制见 `02-技术栈与架构.md`。精确 Zod/JSON Schema、类型和常量仍以本文标出的代码单源为准；修改代码契约时必须同步本文，不在其它文档复制第二份。

## 1. System 与模型请求

### 1.1 System 组装

System 位于 `packages/core/src/prompts/`，由纯 TS section 函数组装。内置身份固定为通用桌面 Agent：持续读取资料、使用工具并推进到完成或明确阻塞；使用用户语言，先给结论，像可靠协作者一样沟通。

System 只包含会话内稳定内容：

- 身份、语言和执行风格；
- 当前工作目录、会话 scratch、OS 与用户主目录；
- 当前 Agent 角色和稳定工具使用规则；
- 权限/讨论模式的稳定说明；
- 当前 Provider 能力决定的少量协议变体。

以下内容禁止拼进 System：TaskPlanState、日期时间、sessionId、随机数、当前进度、后台通知、项目指令、Skill 目录/正文和每请求变化的工具状态。它们必须使用版本化内部消息、工具结果或请求尾部投影，以保持缓存前缀稳定。

自定义 System、项目指令、Skill 和普通用户要求的优先级与生命周期不同，不能互相冒充或绕过权限。

### 1.2 通用执行行为

稳定 System 必须精简表达以下行为：

1. 在形成结论或采取行动前，识别对结果有决定作用的事实。事实可能变化、当前上下文无法可靠确认、存在实质不确定性或需要出处时，先用可用只读工具核实；模型记忆不能替代这类证据。
2. 独立只读操作尽可能并行；有数据依赖、写入顺序或未知前置结果时顺序执行。
3. 修改、评价或诊断代码前先读取相关文件和调用点。已有文本用 `EditFile`，新建或整文件重写才用 `WriteFile`。
4. 对每个需要工具的用户请求，首次工具调用前必须用一小段话说明立即动作；首次调用之后，只有一批工作产生对用户有意义的实质进展（阶段结论、关键事实、完成成果、路线变化或明确阻塞）才用一小段话更新，先说已确认或已完成的内容及其影响，再按需说明接下来方向。长任务不要让用户长时间没有反馈；尚无完整结论时，更新也必须基于实际完成范围、当前发现或明确等待。没有新实质内容就继续调用工具，不为每个工具或下一步计划单独发文字；最终回答仍完整、自包含。
5. 诊断失败后改变参数或方案，不用相同输入盲目重试。
6. 分析、解释、审查或诊断请求不自动改文件；修改保持最小必要范围，不顺手扩展目标。
7. 陌生文件、分支、锁和配置先检查；难以逆转、共享或超出用户范围的动作先确认。只有缺少关键选择、新授权或外部协作时才明确阻塞。
8. 压缩后自然续接已完成进度，不重做工作或重复已交付结论。

Renderer 对“过程/最终正文”的判断只依赖已提交步骤中是否包含工具，不能要求模型用特殊措辞标记最终回答。

### 1.3 Provider 变体

不为每个模型维护完整 prompt 副本。只有真实能力差异可以增加小型条件 section：

- `supportsNativeTools=false`：加入受限 fallback 工具协议。
- 图片输入：当前连接有效画像支持时由 Main 原生接收；否则只有有效辅助视觉连接时提供 `AnalyzeImage`。
- 厂商需要的推理、工具续轮 metadata 由 Provider 处理，不在提示词中伪造。

工具目录由 Agent 角色、宿主能力和 Provider 能力决定，不能按模型名称或用户问题关键词分叉。

### 1.4 请求内消息顺序

普通 Main 请求按以下逻辑顺序投影：

1. 会话冻结的 System；
2. 最新项目指令内部 user 消息；
3. 当前根任务冻结的 Skill 目录内部 user 消息；
4. compact summary 与原始活动历史；
5. 当前运行态内部提醒、canonical TaskPlanState；
6. 最新真实 user、assistant、tool 内容及当前 turn 子代理状态投影；
7. 当前激活 Skill 正文。

控制消息必须使用不可与普通用户文本混淆的版本化容器，并明确“不是新的用户要求”。同一语义只能存在一个活动版本；旧版本可以留在 append-only 审计事件中，但不得同时发给模型。

### 1.5 项目指令

代码单源：`packages/core/src/instructions/`。

- 全局只读取 `~/.whycode/AGENTS.md`。
- 项目从当前目录向上找到最近 Git 根，再按根到当前目录读取；无 Git 根时只读当前目录。
- 每层 `AGENTS.override.md` 优先，否则使用 `AGENTS.md`；空 override 也遮蔽同层普通文件。
- 合并顺序为全局 → 根 → 深层，越深规则越具体。
- 总计最多 32 KiB，优先保留深层内容并保持 UTF-8 完整；读取错误不能伪装成“没有规则”。
- 模型可见内容放在索引 0 的 `<whycode-project-instructions version="sha256:...">` 内部 user 消息中，不进入 System。
- 文件变化时过滤全部旧活动版本，再原位注入唯一新版本；JSONL 只追加变化事件供审计。
- 压缩输入排除项目指令正文，完成后重新读取当前文件并精确注入，不让摘要复述规则。

### 1.6 自定义 System 快照

配置文件为 `~/.whycode/system-prompt.json`：

```json
{
  "mode": "off",
  "file": "SYSTEM.md"
}
```

- `mode` 只允许 `off | append | replace`。off 使用内置 System 且不读取正文；append 追加正文；replace 完整取代内置 prompt 文案，但不能绕过代码权限和 schema。
- 相对 `file` 以 `~/.whycode/` 为基准。配置最多 16 KiB，正文必须是非空 UTF-8 且最多 32 KiB；未知字段、缺失、不可读、空白或超限都使新会话首请求明确失败。
- 只在会话第一次实际模型请求前读取并固化 `{mode,content}` 到 `session-start`。切模型、压缩、恢复和源文件变化都不重读；修改只影响下一新会话。
- 只注入 Main，不传播给 B/C；内容会发送给模型并保存于本地 JSONL，因此不能存放秘密。

### 1.7 Skill 目录与正文

代码单源：`packages/core/src/skills/`、`packages/core/src/tools/skill/`。

每个根任务冻结一份目录：

```text
<whycode-skill-catalog revision="sha256:...">
<available_skills>
- name | id=skill:<path-sha256> | scope=project|user|system | path=... — description
</available_skills>
</whycode-skill-catalog>
```

- 项目级来自 Git 根到当前目录各层 `.agents/skills/`；用户级来自 `~/.whycode/skills/`；系统级来自 `~/.whycode/skills/.system/`。
- 同名项保留不同 ID，不做隐式覆盖。目录按稳定顺序和 revision 进入项目指令之后、历史之前；模型目录预算最多为上下文的 2%。
- `Skill {skillId,resourcePath?}` 只读取当前冻结目录。主 `SKILL.md` 激活后，其完整正文按激活顺序投影到请求尾部；工具原结果从下一请求起替换为稳定占位，避免双份正文。
- 包内资源必须通过相对路径读取，拒绝绝对路径、`.`、`..`、可疑 Windows 路径、符号链接逃逸、非 UTF-8 和超过 512 KiB 的文本。
- 当前 schema 的 `user-input.skills` 最多保存 8 个完整冻结快照；恢复、重提、Fork 与 queued 输入使用原 digest/content，不被磁盘新版本替换。
- Skill 不改变权限、项目、工具注册或检查点；M1、B/C、discussion 和协议回合没有 Skill 目录与工具。

### 1.8 时间、运行态与缓存卫生

- 每个新 turn 首个模型步骤在真实 user 输入之后追加本机日期时间、IANA 时区、UTC 偏移和 UTC；同一 turn 复用，满 5 分钟、跨本地日期或收到新 steering 后才惰性刷新。
- 不使用 watcher 或计时器制造项目指令、Skill 或时间消息。
- `transportSessionId` 是传输元数据：同一 AgentSession 稳定、不同 AgentSession 独立；CLIProxyAPI 使用 `X-Session-ID`。它不进入 transcript、摘要或用户可见正文。
- 普通 Main 的稳定基础工具顺序/schema 不因计划状态变化；非法状态由控制器返回结构化错误。

### 1.9 上下文用量

`ContextUsageInfo` 只描述当前 Main：`usedTokens/contextWindow` 驱动圆环，`autoCompactThreshold` 表示下一次模型请求前的压缩边界，`breakdown.systemPromptTokens/toolTokens/messageTokens` 提供近似解释。`messageTokens` 的语义是此刻模型请求中可见的 messages：真实请求已经装配时按 Provider 边界副本估算，空闲时投影下一次普通请求。普通 Main 的 Skill 目录属于该投影；活动 Skill 正文、当前根任务保留的 Skill 结果和子代理 turn 状态只在各自有效期内计入，根任务结束后必须消失。内部 MCP 状态不发给模型，因此不计入消息；它恢复出的工具 schema 在真实请求装配后计入 `toolTokens`。

`usedTokens` 与压缩器必须读取同一个压力值：有 Provider usage 时使用真实基线并补估其后稳定提交的消息及当前请求投影变化；没有基线时才估算 System、工具目录和消息。分项不要求机械相加等于 Provider 总量。项目指令、时间提醒、任务状态、打断标记与后台终态等一旦稳定提交即属于长期 messages；BTW、Renderer 事件和仅供恢复的内部状态不计入。

`context-usage` 是可空 live CoreEvent。Desktop runtime 保存最新值并进入恢复快照，Renderer 不读取模型能力或历史自行重算；B/C 的独立窗口不计入。该状态不进入 ViewEvent、JSONL、摘要或 Fork，也不增加会话 schema。模型切换使旧值失效，计量失败只隐藏指示器，不能阻断请求。idle 会话即使最终输出越过阈值，也只说明“下次请求前压缩”，不额外制造模型调用；自动压缩连续失败必须显式提示。

### 1.10 BTW 临时侧对话

`btw-message {mode,text,attachments?}` 是独立于普通 `user-message` 的命令。宿主只在会话空闲且已有稳定 Main 背景时接受；协议没有 PDF、Skill 或恢复队列字段，图片必须由当前模型原生接收。BTW 总是创建新 `conversationId`，BBTW 只能续接最近有效侧链；用户输入一经持久化即占用一轮，完成或停止且未满三轮都保留续接资格。普通用户输入、新 BTW、错误、回滚或第三轮终态会结束续接资格。

模型请求顺序为：会话 System 加精简 BTW 边界、Main 稳定消息快照、BBTW 侧历史（BTW 为空）、当前侧输入。停止轮次在原用户消息和可用回复片段后追加与 Main 相同的中断标记，让下一次 BBTW 明确知道此前生成被用户或进程中断。调用 `streamText` 时物理不传工具，侧请求不建立 Main turn、不修改 Main messages、不进入 TaskPlan、压缩或上下文用量。

`edit-user-message` 以 `main turnId` 或 `btw inputId` 作为互斥目标。BTW 编辑只允许最新侧输入，保留其图片、`conversationId`、`turnIndex` 和 `mode`，以新的 canonical 输入身份替换旧输入并移除其后旧回复；编辑重发不增加侧链轮次。输出仍使用普通推理/正文事件；`btw-input` 与 `btw-response` 是唯一持久事实，重放投影的用户消息必须为 `startsTurn=false` 并携带侧链身份。

## 2. 结构化输出与步骤提交

### 2.1 校验原则

WhyCode 自有结构化数据一律以 Zod 为单源并在出口校验，再派生 JSON Schema。MCP 保留服务器原始 JSON Schema，用 AJV 编译受限验证器；无法编译或没有运行时验证器的工具不注册。

能力协商顺序：

1. 原生 strict `json_schema`；
2. tool-based synthetic output；
3. `json_object` 加 schema 提示；
4. 纯文本代码块提取兜底。

统一修复链：剥离代码围栏 → `jsonrepair` → Zod `safeParse`。失败错误回喂模型，最多重试 2 次；仍失败返回结构化错误。

### 2.2 可交付步骤

普通模型步骤必须包含结构化工具调用或至少一段非空可交付正文。只有 reasoning、空白、空 messages，或整条正文仅为泄漏的 `out:default_api:<Tool>{...}` 而没有真实工具调用时：

1. 丢弃整个未提交步骤；
2. 以相同已提交上下文重试一次；
3. 第二次仍不可交付则返回带 finish reason 的可恢复错误。

泄漏协议串不能解析执行；已提交工具不能重放。普通解释或代码示例中提及类似字符串不受影响。

`<system-reminder>`、`<whycode-...>`、`<subagent-settlement>` 和 `<task-notification>` 是宿主保留控制边界，assistant 不得生成。流式出口只缓冲识别开头所需的少量字符，也识别 settlement 内层 JSON 的协议唯一字段组合：顶层伪控制内容不进入 Renderer；无真实工具的整步丢弃并按上述规则重试，伴随真实工具调用时只保留结构化工具消息，不能重放工具。

### 2.3 工具结果与多协议配对

Core 工具结果统一为 `{data,isError}`。图片/PDF 工具可以另返回只供 AgentSession 消费的附件元数据，由稳定步骤转换为绑定原 `toolCallId` 的多模态 tool result 并与消息原子持久化。

每条本地 tool result 必须在同一规范历史中存在对应 assistant tool call。Provider 自行执行的工具不能伪装成本地事实；未知供应商工具及其结果按同一 ID 成组移除。OpenAI Chat、Responses 和 Anthropic 的图片/并行结果差异只在 Provider 请求副本中投影，不改写规范历史。

## 3. 工具契约

### 3.1 通用规则

- 输入先经过 Zod/AJV 校验，再进入权限判定，最后执行。
- 普通 Main 使用稳定工具名称；Provider 序列化差异由适配层处理。
- 所有字符串、集合、递归结构、输出正文、附件和落盘结果都有集中硬上限。
- 外部网页、MCP 说明、文件和 Office 文档内容都是不可信资料，不能覆盖 System、项目规则或用户要求。
- 错误作为普通工具结果回流模型，除非该工具语义明确等待用户或结束当前 run；不为某个 Provider 建立工具错误特判。

### 3.2 基础工具签名

精确 schema 位于 `packages/core/src/tools/`。下表只记录稳定公开形态；字段变化必须同时修改代码测试和本文。

| 工具 | 稳定输入与关键语义 |
|---|---|
| `ListDir` | `{path,offset?,limit?}`；有界目录分页 |
| `Glob` | `{path,pattern,offset?,limit?}`；有界文件名匹配 |
| `Grep` | `{path,pattern,outputMode?,include?,caseSensitive?,literal?,context?,offset?,limit?}` |
| `ReadFile` | 路径加有界 offset/limit；只读 UTF-8/支持的文本 |
| `WriteFile` | `{path,content}`；只用于新建或整文件重写 |
| `EditFile` | `{edits:[{path,oldText,newText,replaceAll?}]}`，1～50 项，基于调用开始时原快照原子预检 |
| `DeleteFile` | `{paths}`，1～50 个普通文件；全量预检后作为一个回滚单元 |
| `MoveFile` | 单个普通文件源/目标；目标必须不存在，不递归目录、不静默覆盖 |
| `RunCommand` | `{command,cwd?,timeoutMs?,runInBackground?,wakeOnCompletion?}`；默认前台非交互等待且无 stdin；后台任务由 Header 与命令任务工具管理，只有显式 `wakeOnCompletion=true` 才登记终态续轮；不扫描工作区、不建文件检查点 |
| `ListCommands` | 列出当前会话可见命令任务 |
| `GetCommandOutput` | 增量读取命令输出 |
| `WriteCommandInput` | 给仍存活命令写 stdin；按 execute 权限处理 |
| `StopCommand` | 终止所属进程树；属于保护性控制 |
| `AskUserQuestion` | `{questions:[...]}`，1～6 问；每题标题、问题与 2～4 个互斥选项 |
| `Skill` | `{skillId,resourcePath?}`；只读当前根任务冻结 Skill |
| `Subagent` | `{agent_id,description,prompt}`；异步启动并立即返回稳定 UUID |
| `SendSubagentMessage` | `{subagent_id,prompt}`；仅继续当前父会话已终态子代理 |
| `ListSubagents` | `{}`；列出当前父会话保留子代理的 agent_id、稳定 ID、任务描述与状态 |

`EditFile` 的每项 `oldText` 默认必须唯一；只有显式 `replaceAll` 才替换全部非重叠匹配。重叠、依赖前一编辑结果、无变化或任一文件预检失败时整次调用拒绝；写入异常恢复本次已尝试文件。

`AskUserQuestion` 只用于答案会实质改变下一步、无法从上下文/只读工具确认且没有安全默认值的情况。不得在任务已可交付时询问满意度或可选后续。UI 自动提供自由输入，模型不得伪造“其它”选项。成功后结束当前 run 并等待整批一次回答；它是工具步骤，执行过程不收起。

### 3.3 后台任务通知

只有 `RunCommand(runInBackground=true)` 在离开当前工具步骤后继续，任务状态由宿主投影到 Header 后台任务菜单。`wakeOnCompletion` 默认 `false`，且设为 `true` 时必须同时启用后台模式；只有这类已登记任务在自然进入 `completed` 或 `failed` 后，才向所属模型会话注入：

```text
<task-notification source="background-command" version="1">
  task_id, status, exit_code, command, working_directory,
  output_bytes, output_truncated, failure_reason?
</task-notification>
```

通知是内部 user 消息但不是用户要求，不生成用户气泡。用户主动停止任务或应用退出不生成自动唤醒。宿主根据会话与计划所有权决定是否续轮；模型不得用 Sleep 或高频轮询等待。

### 3.4 Web

`WebSearch {query,max_results,recency?,domains?}`：

- `query` 是 1～500 字符字符串，或 2～4 个互不重复、可独立作答的查询；单个查询表达一个检索目标。
- 每查询目标默认 5、最多 10 条，总结果最多 20；recency 为 hour/day/week/month/year，domains 最多 10 个域名。
- 用于搜索和核实公开网页的当前事实、官方资料和来源。模型记忆不能替代需要核实的事实，但已有充分依据且核实不实质提高可靠性时无需搜索。
- 搜索后端、score 和厂商字段不进入模型 schema；结果按规范 URL 去重并生成 `[Sx]` 来源。

`WebFetch {url,offset?,limit?}` 只读取无需登录的公开 HTTP(S) 页面。已知 URL 直接读取，不先搜索；正文转为带稳定行号的 Markdown，单次最多 100 行/9k 字符，并返回总行数与下一 offset。命中 PDF 时导入为当前会话 PDF 附件，再用 `ReadPdf`。

`WebFind {url,pattern,context=2,max_results=10}` 只在本会话已缓存的同一 WebFetch 正文中做字面查找，不联网、不重新抓取、不查 PDF。

普通公开读取失败，或用户明确需要授权/登录/私有数据时，再用 `ToolSearch` 查对应 MCP 能力。研究类最终交付在关键结论附近引用真实 URL，并在末尾去重列出来源；执行任务中的中间查证无需强制输出引用。

### 3.5 MCP

`ToolSearch {query,max_results=5}` 本地检索已配置 MCP 目录，max_results 为 1～8；查询和目录不发送给第二模型或外部搜索服务。命中结果只让精确 `Mcp__<server>__<tool>__<hash>` 在下一模型步骤注册，同一步不能立即调用。

每个会话最多加载 64 个 MCP 工具，模型定义合计不超过 256 KiB。`<whycode-mcp-tool-state:v2>` 保存 descriptor 引用、服务器 runtime fingerprint、受限 initialize instructions 与可空项目配置信任；它从摘要输入排除，并在压缩后由宿主精确重建。

实际 MCP 工具无论 `readOnlyHint` 都按外部 execute 进入统一权限链。凭据、OAuth token、授权 URL 和 callback code 不进入模型、JSONL、工具结果或 Renderer；外部内容先做结构限额与凭据型 URL 字段脱敏。配置或 descriptor 变化时旧工具失效，不能绑定到新实现。

### 3.6 图片与截图

- 单条用户消息最多 10 张 PNG/JPEG/WebP，与正文共享不可拆分 delivery ID。长期消息保存附件 ID/显示名/路由，不保存绝对路径或 Base64。
- `ViewImage` 读取当前会话/权限允许的图片，支持 high、经画像验证的 original 与 autoOrient 后源像素 region；结果返回模型到源图映射。
- `CaptureScreenshot {target,display_id?,window_title?,region?,detail}`：target 为 screen/window/region。外部单窗口优先 window；Windows 捕获事务排除 WhyCode，不通过隐藏/显示制造画面抖动。
- `AnalyzeImage {attachmentIds,question}` 只给非视觉 Main 且必须有有效辅助视觉连接；每次 1～10 张。辅助请求不接收主历史、项目、文件名、工具或密钥。
- 用户输入最多 10 张；普通视觉工具、MCP 和 `RenderOffice` 单步骤最多 4 张。视觉 `ReadPdf` 使用自身最多 20 页/32 MB 边界。
- Base64 只存在于无路径剪贴板发送前和当前 Provider 内存请求；JSONL、CoreEvent、ViewEvent 与摘要只保存稳定引用。

### 3.7 PDF

`ReadPdf {sourceType,sourceValue,startPage,pageCount}`：sourceType 为 attachment 或 path；视觉 Main 返回 100 DPI JPEG 页面图，默认/最多 20 页；非视觉 Main 返回文字，默认 5、最多 20 页且总计最多 60k 字符。结果始终含总页数、当前页段和下一页游标。

小 PDF 自动展开只适用于视觉 Main、用户上传的最近权威引用，单份和单请求均最多 10 页、总图 16 MB。Web 导入、大文件或超预算文件必须显式 `ReadPdf`。PDF 与页面缓存以附件摘要和事务校验；损坏、加密、空或越界输入明确失败。

### 3.8 Office

- `BuildOfficeArtifact {format,mode,scriptPath,outputPath,assets[],templateAssetKey?}`：format 为 docx/pptx/xlsx，mode 为 create/template；模板模式必须精确引用模板 asset。脚本在无 Node 权限的 SES 中执行，最终原子发布。
- `InspectOffice {path,startUnit=1,unitCount=20,view="content",sheetName?,range?,slideNumber?}`：view 为 content/objects/styles/relationships/validation/template/formula-trace；分页只能使用返回的 nextUnit，单次最多 50 单元、60k 文字。
- `RenderOffice {path,view="pages",startPage=1,pageCount=4}`：只给视觉 Main且独占步骤；pages 最多 4 页，overview 最多 50 页合成一图。

创建/修改前必须读取当前 Office Skill 的 builder API；模板 PPTX 还需读取 template-following 规则。接口失败应修正同一 builder，不切换到命令或手写 OOXML 的第二实现。含公式 XLSX 只有真实 Office/LibreOffice 引擎重算、保存并复检成功后发布。非视觉 Main 只能声明结构检查；视觉 Main 还要对最终版本完成全页渲染复核。

## 4. 上下文压缩契约

代码单源：`packages/core/src/context/`，提示词位于 `packages/core/src/prompts/compact.ts`。

### 4.1 统一入口

手动与自动压缩先运行同一 microcompact：只替换白名单内可重现的大型 tool result，并保持 tool call/result 原子配对。只要自动 microcompact 实际改变消息，就提交 compact snapshot，不依赖是否继续 full compact。

full compact 以 token 而不是“至少保留几条文本消息”为边界：

- 默认保留约 20k token 的原始安全尾部；
- 切点只在安全 user/assistant 边界，永不拆散 tool call/result；
- 尾部包含真实用户输入时，对更早历史生成常规摘要；
- 尾部仍位于同一超长 turn 时，另对该 turn 前缀生成专用摘要。

### 4.2 九节历史摘要

常规摘要固定覆盖：

1. 历史任务与意图；
2. 持久约束与偏好；
3. 关键技术概念与决策；
4. 文件、代码与产物；
5. 错误与修复；
6. 问题解决与确认结果；
7. 用户请求与纠正；
8. 截断点尚未解决的事项；
9. 后续理解所需关键背景。

第 7 节覆盖被压缩范围内所有有实质意义的用户请求、目标调整和纠正，但不机械复制闲聊或重复仍在精确保留尾部中的消息。第 8 节只记录截断点当时的历史状态，不能把它声明为当前待办。常规摘要禁止添加“当前工作”或“下一步”；当前状态只由 20k 原始尾部和宿主重新注入的权威状态决定。

### 4.3 同 turn 前缀摘要

专用摘要只回答：原始请求、早期进展、后续所需上下文。它不能替代常规历史摘要，也不包含尾部已逐字保留的内容。一次压缩请求可以要求模型分别输出两份内容；宿主分字段校验后再重建。

重复压缩只压当前会发送给模型的活动上下文，增量更新摘要，不回读完整旧 transcript。项目指令、Skill 正文、MCP state、TaskPlanState 和自定义 System 不交给摘要模型续命，而在压缩后从权威状态重建。

## 5. TaskPlan 契约

代码单源：`packages/core/src/tasks/types.ts`、`tools.ts`、`controller.ts`。

### 5.1 状态

内部 `TaskPlanState`：

```ts
{
  version: number
  activePlan: {
    id: UUID
    goal: string
    status: 'active'
    revision: number
    items: Array<{
      id: `T${number}`
      kind: 'work' | 'verification'
      outcome: string
      status: 'pending' | 'in_progress' | 'completed'
      evidence: string[]
    }>
  } | null
  resumeRequired: boolean
  interruptionReason: 'user-cancel' | 'process-interruption' | 'consensus-failure' | null
}
```

计划有 2～7 项且最后一项是唯一 verification；最多一个 in_progress。completed 必须有 evidence，未完成项不能带 evidence。模型可见 XML 使用版本化 snake_case 投影，但不得形成第二状态源。

### 5.2 工具和转换

- `CreateTaskPlan`：无活动计划时创建 3～7 个宏观里程碑；独占步骤，初始全 pending。
- `ResumeTaskPlan`：恢复 interrupted/dormant 的同一目标；独占步骤。
- `UpdateTaskItem`：原子增删改排未来项，并可把一项声明为 in_progress/completed；幂等状态重放成功但不增加 revision/version。
- `CloseTaskPlan`：用户明确放弃或切换目标时关闭；无参数、无总结，独占步骤。

每个计划工具结果先返回 `<whycode-task-result schema-version="1">`，再返回最新 `<whycode-task-state schema-version="1">`。非法转换返回结构化错误和当前状态。

正常 engaged run 的完整无工具最终正文在同一稳定 step 自动清空 active plan；全部项完成记 completed，否则 ended。用户 Stop、必要 `AskUserQuestion`、明确暂缓或等待后台/子代理终态时保留。自然最终回答是唯一交付总结，Close 不传灰色总结文字。

只有一个 turn 已通过稳定计划工具或绑定问题答案获得 execution 权限时才 engaged；新顶层 user turn 不继承。硬中断写 `resumeRequired`，之后必须 Resume。普通 dormant 计划不因无关聊天自动注入执行权。

### 5.3 提问续接

模型持久事件为 `<whycode-user-question version="2">`，包含完整 1～6 问批次与 `resumesTaskPlan`。整批答案一次发送：单题为 `回答「问题」：内容`，多题按原顺序编号。只有来自同一 active plan 必要等待点的完整答案可续接；硬中断仍先 Resume。普通输入或仅提到内部标签不能伪造控制语义。

## 6. 多 Agent 契约

### 6.1 协商

工程单源：`packages/core/src/consensus/types.ts`、`protocol-tool.ts`、`prompts.ts`；协议原文：`E:\Agent\multi-agent-decision-protocol.md`。

候选、投票与最终协议输出通过 `SubmitProtocolOutput` 合成工具提交。`agent_id`、round 和 candidate_id 由 Orchestrator 分配；schema 随轮次收窄。成功提交立即结束当前协议 turn，普通正文不作为第二结果。失败把结构化错误交还模型修正；连续失败按协议标记 invalid 并降级 Main 终判。

讨论阶段 Main/B/C 可读项目并在自己的 scratch 写/执行，不能修改原项目或产生外部副作用。Web、MCP、Skill、视觉、PDF、Office、TaskPlan 等执行工具物理移除。协议输入、candidate 事件、memory summary 和最终执行包各有独立类型，不能用 UI 卡片反推模型上下文。

### 6.2 子代理

工程单源：`packages/core/src/subagents/`。

父 Main 请求中提供稳定 `<available_subagents>`，当前画像为 explore/reviewer/general。`Subagent` 以 `description` 保存本次任务的 3～5 词语义名称并立即返回 subagent ID；`ListSubagents` 可在不暴露完整 prompt、结果或 transcript 的前提下重新发现当前会话的既有子代理。终态由运行时以 settlement 通知父会话，不依赖子模型主动调用汇报工具。settlement 的 outcome 为 `completed | error | aborted | limit | refusal`，结果最多保留 Unicode 安全的 48,000 字符。

每次 activation 有独立 transcript、TaskPlanState 和 scratch；新建激活只接收父模型的自包含委派，不复制父完整历史、父计划、用户问题卡或临时控制状态。终态后 AgentSession 立即卸载。`SendSubagentMessage` 只能继续当前父会话拥有且已终态的 ID，从 transcript 冷启动；不能并发激活同一 ID。子代理不能提问用户、Fork、操作父计划或扩权。

新建子代理的模型在宿主创建边界冻结：未固定时继承父会话当前模型，固定时只能引用当前已配置连接；推理档位收敛到目标模型能力闭集。后续 continuation 使用 manifest 中的原模型快照，不重新继承父模型或读取新的全局选择。

settlement 先随子 manifest 持久化为 pending；父 transcript 写稳通知后才标记 delivered。父会话运行中时在下一稳定边界插入，空闲恢复产生的旧终态才开启隐藏续轮；完整压缩不能摘要或拆散未消费通知。父 Stop 或删除会中止激活并直接确认取消终态，不再唤醒父会话；仅当 Stop 实际取消未完成子代理时，同一持久中断标记附带这些子代理的稳定 ID 与任务描述。应用退出产生的未交付终态留待下次恢复，单纯切换会话不影响运行。

同一父 turn 内以 `(parentTurnId, activationId)` 跟踪启动和继续产生的全部 activation。每次模型请求在尾部投影当前总数、终态数、已交付数、任务描述和逐 activation 状态；投影不写入 transcript，turn 结束后不再出现，结果正文只存在于 settlement 消息。

父代理派发后继续执行不与子任务交叉的本地工作；每个 settlement 到达即可作为阶段进展进入下一模型步骤，不等待最慢子代理批量汇总。若父代理已经无事可做但仍有未交付 activation，`runLoop` 保持同一 turn 进入一次性事件等待，不发起空模型请求；用户 steering、任务通知、子代理终态或 Stop 都可唤醒。直接插入用户消息仍属于同一 turn，并在后续请求继续携带更新后的子代理状态；显式 Stop 是硬边界，会取消本会话全部运行中子代理并结束父 turn，下一条用户消息开启新 turn。只有本 turn 全部 activation 终态已交付后，无工具正文才允许自然结束；这只解除等待闸门，不要求立即结束，父代理仍须完成必要工作、核验和最终交付。

## 7. Fork、持久化与恢复

Fork 点必须同时满足：模型 turn completed、`work-finished.forkTurnId` 指向该 turn、存在非空可交付最终正文。停止、错误、等待用户、纯工具或半截流式步骤不是 Fork 点。

Core 从源 JSONL 活动父链复制锚点处真实上下文，包括 compact 状态、模型/推理选择、项目指令、Skill 快照、TaskPlanState、MCP 状态与附件引用；排除锚点后草稿和队列。新会话拥有独立 JSONL、运行时、附件/检查点副本和 scratch；源后台任务与临时授权不转移。

所有恢复都从已提交事件和 canonical snapshot 重建。ViewEvent 缓存、Renderer 展开状态、模型自述和摘要都不能补造业务状态。当前开发 schema 不兼容旧格式；不支持的旧会话明确不可打开但仍可删除。

运行中的普通输入先以 `user-input(startsTurn=false)` 写稳并进入 canonical pending inputs。`queued-message-action` 只能引用仍为 `queued` 的稳定输入 ID：`edit` 追加 `user-input-restored` 并通过 `queue-restored` 退回原消息草稿，重新提交时原子消费旧 ID；`discard` 追加 `user-input-discarded` 并删除 pending 身份，实时界面只接收非持久的 `message-dequeued`；`send-now` 不创建第二条输入，只复用 urgent steering 中断当前步骤并在安全边界交付原 ID。任何持久化失败都必须保留原队列，不能先向 Renderer 宣称成功。

## 8. 推理与模型选择

Provider 把 Anthropic thinking block、DeepSeek/MiMo/GLM reasoning field 和 OpenAI reasoning summary 统一映射为 `thinking-delta`，但后续回传仍遵守各厂商原协议和 metadata。B/C reasoning 不进入紫色候选卡片。

Renderer 在工具折叠等展示投影完成后，把最终可见序列中相邻的思考片段合并为同一块，按顺序追加内容并累计已完成时长；仍可见的正文、工具、用户消息等构成合并边界。原始 Block 顺序、持久事件和 Provider 回传均保持不变。

推理展示与计算强度独立：

- `reasoningExposure` 决定是否存在 block/field/summary；
- `reasoningEffort` 为 `default | none | minimal | low | medium | high | xhigh | max` 的当前连接闭集；
- default 表示请求不覆盖连接默认，不等于某个固定强度；
- Renderer 只显示当前有效画像允许的档位，Main 再校验，Provider 翻译为实际协议字段。

模型和强度在 turn 起点冻结。退役 modelId 的历史可读但没有可发送 AgentSession；用户必须主动选择受支持型号，系统不得静默替换。模型目录更新流程见 `.agents/skills/whycode-model-catalog/SKILL.md`。

视觉辅助模型和固定子代理模型只保存统一连接 ID，不复制密钥或端点。连接失效时逐项清除设置；运行中的既有 AgentSession 不被热替换。

## 9. 修改契约的检查清单

修改任何模型、工具、事件或持久化协议前后必须确认：

1. 权威类型/Zod/JSON Schema 是否仍只有一处；
2. System、内部消息、工具结果和用户正文的角色是否明确；
3. Provider 请求副本是否会意外改写规范历史；
4. commit/discard、Stop、steering、重试和错误路径是否原子；
5. JSONL、恢复、压缩、Fork、回滚和共识事务是否一致；
6. Renderer 是否只消费投影，而没有复制协议判断；
7. 权限、会话归属、路径、资源与容量边界是否 fail-closed；
8. 旧代码和失效 schema 是否同步删除；
9. 受影响契约测试、全仓 typecheck、生产 build 与 `git diff --check` 是否通过。
