---
name: whycode-model-catalog
description: Maintain WhyCode's built-in model catalog and audited CLIProxyAPI routes. Use when adding, replacing, retiring, or auditing model IDs, capabilities, reasoning efforts, provider options, or CLIProxyAPI compatibility. Do not use for ordinary model selection, API-key setup, generic provider debugging, or UI-only model picker changes.
---

# WhyCode Model Catalog Maintenance

本 Skill 是 WhyCode 模型身份与能力变更的唯一详细工作流；同时遵守 `docs/04-START-HERE.md` 的质量红线。固定顺序是：**界定范围 → 建立证据表 → 更新内置目录 → 按需更新 CLIProxyAPI → 清理旧实现 → 验证完整链路**。前一阶段的依据未完成前不得先改目录，未经验证的能力不得开放。

## 1. 先界定本次变更

动代码前列出用户明确点名的型号，并为每个型号确定：

- 操作是新增、保留、替换还是退役；
- 目标是内置厂商连接、CLIProxyAPI 路由，还是两者；
- 是否改变默认型号、推理档位、协议、历史展示或配置结构。

“保留”表示新旧型号分别拥有完整画像和测试；“替换”表示从活动目录、注册表、默认配置、设置页、测试和正式文档完整删除旧型号。不得保留跨版本别名、隐藏兼容分支或第二套 `providerOptions`。厂商迁移建议不等于 WhyCode 自动迁移：除非用户明确要求，旧会话的 `modelId` 不重写，对话和附件不删除。

内置厂商与 CLIProxyAPI 必须分阶段处理。阶段 A 默认只更新内置厂商，不为新型号新增或升级 CLIProxyAPI 路由；`apps/desktop/src/main/cli-proxy-models.ts` 通常保持不动。若替换或退役使既有兼容项指向已删除画像，只删除该悬空旧项，不得据此推断或接入替代路由。阶段 B 只有用户明确要求更新 CLIProxyAPI 的具体型号时才开始。CLIProxyAPI 的常规同步范围只有 OpenAI、Anthropic 和 Gemini，并且只处理用户当轮明确点名的型号；同一请求中的其它内置厂商型号不因此获得 CLIProxyAPI 接入。

## 2. 先建立一手证据表

以厂商当前官方模型页、API、迁移和弃用文档为主，记录来源链接与核对日期。每个型号至少核实：

| 类别 | 必须确认的事实 |
|---|---|
| 身份与生命周期 | 正式 API ID、展示名、稳定或预览状态、弃用/下线状态及替代关系 |
| 协议与能力 | 协议端点、输入/输出模态、流式、原生工具调用、结构化输出、缓存行为 |
| 资源边界 | 上下文窗口、最大输出，以及会改变 WhyCode 请求边界的其它硬限制 |
| 推理契约 | 推理内容形态、可显式设置的档位、默认档位、后续工具轮必须回传的签名/摘要或 provider metadata |
| 适配器 | 仓库当前锁定的 AI SDK 版本能否无损表达上述契约，所需 `providerOptions` 和请求字段 |

厂商没有证明的能力一律不猜，不能因为名称、代际或参数相近而继承。共享画像常量只能在逐字段确认完全相同后用于去重；任一字段分化时必须拆开。工作期间可在当前任务记录中保存证据，完成后只把仍待核实的事项留在 `docs/05-暂存区便签.md`；CLIProxyAPI 路由中不直观的约束必须在代码旁保留发布版、提交或目录来源。

## 3. 按职责修改唯一事实源

修改前用 `rg` 确认消费者；当前职责如下：

| 位置 | 唯一职责 |
|---|---|
| `packages/core/src/providers/catalog.ts` | 厂商型号的稳定内部 ID、正式 wire ID、展示名和官方固有画像 |
| `packages/core/src/providers/registry.ts` | 内置厂商协议工厂与目录装配，不复制能力事实 |
| `packages/core/src/providers/reasoning-effort.ts` | 把会话推理档位归一并翻译为当前协议字段 |
| `apps/desktop/src/main/cli-proxy-models.ts` | 已审核等价路由的精确 ID、最小收窄约束和证据版本 |
| `apps/desktop/src/main/cli-proxy-discovery.ts` | 将静态审核候选与目标实例鉴权后的 `/models` 求交集 |
| `apps/desktop/src/main/model-connections.ts` | 把目录、当前配置和路由合成为可用连接，并处理退役占位 |
| `apps/desktop/src/main/model-settings.ts` | 从上述事实源生成设置快照和保存边界 |
| `apps/desktop/src/main/config-storage.ts` | 持久化连接选择和最小历史元数据，不维护活动能力画像 |
| `apps/desktop/src/main/retired-model-labels.ts` | 按历史会话真实引用清理退役型号展示名 |

UI、Main 和 Provider 不得另建能力表。不得按版本号散落 `if/else`、保留任意型号兜底、复制整份能力对象或创建平行 `providerOptions`。变更使常量、类型、IPC、配置字段、测试夹具或说明失效时必须同步删除；现存一次性配置迁移只可保留历史显示仍需要的最小数据，不能借模型更新复活旧运行时逻辑或新增旧会话兼容。

## 4. 更新内置厂商目录

1. 在 `catalog.ts` 写入证据表确认的精确画像；内部 ID、厂商 wire ID 和展示名必须各自语义明确。能力未知时关闭或省略，不能取同系列型号的值。
2. 只有协议工厂或官方请求适配发生变化时才改 `registry.ts`；特殊参数只放在该型号唯一的 `providerOptions`。
3. 同步检查默认型号、设置快照、辅助视觉模型、协商模型、上下文压缩阈值和所有精确 ID 消费者。
4. 替换或退役时删除活动路径中的旧型号及死代码；阶段 A 到此结束，不顺手更新 CLIProxyAPI。

## 5. 退役型号必须历史可读、不可发送

同一当前可恢复 schema 内，引用退役型号的历史会话仍须完整打开。顶栏保留最后使用的原型号名并以红色“已停止支持”显示；下拉框不得伪造选中项，Main 的当前模型解析边界必须在发送前要求用户主动选择现有型号。

禁止静默回退默认模型、改写 JSONL，或把旧 ID 作为新型号别名。用户明确切换后只更新当前会话。退役显示名是引用型历史元数据：只为仍引用该型号的会话保留；删除会话时按其余会话引用清理，既不能留下孤儿配置，也不能误删其它会话仍需的名称。模型退役不得新增 schema 迁移、双读或旧事件分支。

## 6. 仅在明确要求时更新 CLIProxyAPI

阶段 B 先复用仍然有效的厂商画像，只补查 CLIProxyAPI 路由事实；厂商契约已变化时仅刷新受影响字段。证据至少覆盖：

- 当前 CLIProxyAPI 发布版及源码；
- `internal/registry/model_updater.go` 指向的官方远程目录与对应提交；
- 内嵌离线目录、Provider/客户端专用元数据和启动边界；
- OAuth 别名、入口协议、推理参数翻译和账号限制；
- 目标实例鉴权后的标准 `/v1/models`。

静态候选必须由 CLIProxyAPI 的官方内嵌或远程目录证明指向同一真实型号，再与目标实例 `/models` 求交集。`/models` 通常只证明 ID 和当前账号可用性，不能生成能力画像；不能只搜索二进制内嵌表，也不能把路由名、成功响应或模型自述单独作为身份依据。路由名可以不同，但旧版、近似名和未审核 alias 不得冒充新型号。无权威同型号路由契约时，该型号不得出现在 CLIProxyAPI 可启用列表。

## 7. CLI 路由按字段收窄

`cli-proxy-models.ts` 只保存路由相对厂商画像的最小约束，由唯一合成函数产生有效画像；不得复制一份完整 CLI 模型注册表，也不得用无字段规则的整对象继承或普通覆盖代替能力合成。

| 字段 | 合成规则 |
|---|---|
| 型号身份、官方说明、知识边界 | 以厂商画像为准，CLI 路由不得反向改写 |
| 上下文与最大输出 | 取厂商上限和路由上限的较小值 |
| 布尔能力 | 显式 `false` 优先；CLI 不得开启厂商尚未验证的能力 |
| 结构化输出 | 取双方都保证的最高共同档位 |
| 推理档位 | 取闭集交集；路由缺少的档位不能从厂商补回 |
| 默认档位 | 使用路由明确默认，否则使用仍位于交集内的厂商默认 |

缺失只表示未知。只有已审核为同一型号且确认对应字段完整透传时才可继承，否则关闭该能力或暂不接入；路由独立默认值必须显式记录。型号名中的 low/high 可以表示路由默认，但不能代替请求体档位。`supported_parameters`、输入模态和推理档位互不证明；Codex `ultra` 等包含产品编排语义的模式不得冒充通用 API 推理强度。

同一 ID 可能来自多个 OAuth Provider 而 `/models` 无法区分时，取所有可能路由的安全交集；无法得到可靠交集则拆分路由或不开放。审核结果固定随 WhyCode 发布，应用启动时不得从可变 GitHub 目录动态拼装画像。

## 8. 保持推理强度端到端一致

推理强度按“会话选择 → 当前连接有效画像 → 协议翻译”处理。内置目录逐型号声明厂商档位和默认值，CLI 连接再按第 7 节收窄；UI 只展示当前连接真实档位。内部 `default` 映射为该连接默认显示；没有可验证档位时固定显示灰色“推理：默认”。

推理选择与连接限定的 `modelId` 同属会话事实。切换模型时回到 `default`；模型或路由升级后，旧选择不在新闭集时，恢复和发送边界都归一到当前连接默认值，绝不能继续发送非法档位。Provider 必须按实际协议翻译：

- OpenAI Responses：`reasoning.effort`；
- OpenAI Chat：`reasoning_effort`；
- Anthropic Messages：adaptive thinking + `output_config.effort`。

内置中转与 CLIProxyAPI 共用同一链路；禁止依赖 UI 文案或模型名括号后缀控制请求。

## 9. 验证矩阵与完成条件

按本次范围覆盖以下矩阵，不适用项应在交付说明中明确标为不适用，而不是静默跳过：

- **目录与设置**：目录/注册表唯一性、设置快照、只显示已配置连接、模型切换和重启恢复、辅助视觉与协商模型候选；
- **CLIProxyAPI**：审核候选、逐路由约束、鉴权 `/models` 解析、实际 wire ID、官方与 CLI 同型号互不污染；
- **上下文与推理**：上下文上限进入自动压缩，档位交集、默认值、非法旧选择归一，以及 Responses、OpenAI Chat、Anthropic 三种请求线格式；
- **Agent 能力**：图片、工具、结构化输出边界，推理签名/摘要在后续工具轮的回传；
- **退役与配置**：历史打开、原名展示、切换、删除、发送拦截，以及受本次改动影响的既有配置迁移；不得为测试新增旧会话迁移；
- **清理**：新旧型号 ID、失效常量、死代码、重复画像和疑似密钥字面量的全仓搜索。

先运行受影响的定向测试，再运行全仓检查：

```powershell
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

能访问真实端点时，关闭自动重试后做最小烟测，避免重试掩盖路由或协议错误。交付时必须区分“离线适配器/请求捕获测试”和“真实模型验收”，并明确未测项及原因；进行中的未测项可留在 `docs/05-暂存区便签.md`，完成结论只写入当次交付说明和 Git 历史。

只有在以下条件全部满足时才算完成：每个变更字段都有一手依据；只修改用户授权的型号和连接范围；目录仍为单一事实源；旧型号与死代码已按语义清理；自动化检查通过；真实端点覆盖范围和限制已如实说明。
