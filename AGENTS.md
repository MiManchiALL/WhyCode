# WhyCode 开发约定

WhyCode 是 Windows 优先的 Electron + React + TypeScript 桌面 Agent。按任务读取下表中的文档，不要求每轮通读；详细红线与文档地图见 [开发指南](docs/04-START-HERE.md)，验证和 PR 流程见 [CONTRIBUTING](CONTRIBUTING.md)。

## 常驻规则

- 先检查 Git 状态和 [未竟事项](docs/05-暂存区便签.md)，保留用户及其它任务的改动；在功能分支上完成工作。
- 先查现有实现和测试，修正根因，复用现有职责；只实现当前需求，同步删除失效代码，不堆外围特判、重复状态、未来抽象或第二套实现。
- Core 不依赖 Electron/DOM；Main 管理宿主资源；Renderer 消费投影，不直读密钥、文件或进程。类型、协议和业务事实保持单一来源。
- 不为旧测试/开发会话增加迁移、双读或展示兜底；只有用户明确要求兼容已发布数据时才重新设计边界。
- 资源必须有明确所有者、取消与释放路径；不得清理用户原有文件或其它任务资源。异步与错误处理遵守开发指南 §6。
- 本地默认定向运行受影响行为及调用方的测试，按风险扩大范围；有效结果不因提交、推送重复执行，不把未执行或跳过的验证写成通过。
- 默认由你整理本地提交和 PR 说明，用户推送分支、创建并验收合并 PR；未经授权不推送或合并。进入 main 前须通过 CI。
- 不提交密钥、真实会话数据、构建产物、临时文件或外部参考源码。稳定事实更新所属文档，未完成事项写入便签，完成历史留在 Git。
- 仅在长期开发约定、任务导航或源码定位实际变化时同步修订AGENTS.md；日常功能细节、临时进展和局部修复不写入。

## 按任务读取

| 任务 | 动手前阅读 |
|---|---|
| 修改代码 | [通用红线](docs/04-START-HERE.md#51-通用代码红线)；文档二中对应模块与相邻调用方 |
| Renderer/UI | [前端红线](docs/04-START-HERE.md#52-前端开发附加红线涉及-rendererui-时必须遵守)；[文档二 §12](docs/02-技术栈与架构.md#12-renderer-架构与视觉基线) 中相关小节 |
| 模型输入、工具、事件、IPC、持久化 | [文档三](docs/03-Agent与协议契约.md) 对应契约及 §9 检查清单 |
| 异步、取消、进程、浏览器、资源清理 | [开发指南 §6](docs/04-START-HERE.md#6-异步资源与错误处理)；对应模块的生命周期契约 |
| 新增、替换、退役或审核型号及 CLIProxyAPI 路由 | [模型目录 Skill](.agents/skills/whycode-model-catalog/SKILL.md) |
| 编辑、审查或整理项目文档 | [文档治理 Skill](.agents/skills/whycode-doc-standards/SKILL.md) 与 [文字规范 Skill](.agents/skills/whycode-prose-standard/SKILL.md) |
| 依赖与构建 | [开发依赖与缓存](docs/02-技术栈与架构.md#12-开发依赖与缓存)、[安全例外](docs/06-依赖安全例外.md) |

## 源码定位

- `packages/core/src/`：Agent、Provider、工具、权限、上下文与会话语义。
- `apps/desktop/src/main/`：Electron 宿主；`preload/`：最小桥接；`renderer/`：界面；`shared/`：IPC 类型与共享投影。
- `remote/`：Linux SSH 组件；`workspace-runtime/`：独立工作环境；`scripts/`：资源构建。
- [文档二](docs/02-技术栈与架构.md) 解释实现机制，[文档一](docs/01-需求与MVP.md) 解释产品范围；精确类型与 schema 在代码中维护。
