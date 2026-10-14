# 社区 VS Code AI 能力实现分析（性能视角）

> 分析对象：`microsoft/vscode` `main` @ `0ea598a48bf`（2026-10-13，版本 1.143.0）。
> 本仓库当前基于 1.113.0，部分模块在本仓库中不存在或较旧，见文末「版本差异」。
> 文中路径如无特别说明均相对于社区仓库根目录。

## 结论

社区的 AI 体验快，根本原因是：**界面、会话模型、工具、文件编辑、MCP、提示文件全部是基座里的原生代码**，运行在渲染进程，不依赖扩展是否已激活。
Copilot 扩展只负责「大脑」：拼 prompt、调模型、跑工具循环，并以批量 IPC 把进度推给基座。

最新的 Agent Host 更进一步：把大脑放进一个独立的 utility 进程，通过 MessagePort 与渲染进程直连，完全绕过扩展宿主。

## 代码规模（非测试 `.ts`）

| 目录 | 行数 |
| --- | ---: |
| `extensions/copilot/src`（Copilot 扩展，已并入仓库） | 37.4 万 |
| `src/vs/workbench/contrib/chat` | 34.3 万 |
| `src/vs/platform/agentHost` | 24.2 万 |
| `src/vs/sessions`（Agents 窗口） | 17.6 万 |
| `contrib/chat/browser/widget`（chat 子目录） | 7.6 万 |
| `contrib/mcp` + `platform/mcp` | 3.2 万 |
| `contrib/terminalContrib/chatAgentTools` | 2.1 万 |
| `contrib/chat/browser/chatEditing`（chat 子目录） | 1.3 万 |
| `contrib/chat/common/promptSyntax`（chat 子目录） | 1.2 万 |
| `contrib/inlineChat` | 0.4 万 |

## 一、整体架构：三个进程，两条请求链路

```text
┌────────────────────────┐   RPC 批量推送    ┌──────────────────────────────┐  MessagePort 直连  ┌──────────────────────────┐
│ 扩展宿主进程 (Node)    │ ◀──────────────▶ │ 渲染进程 (workbench 基座)    │ ◀───────────────▶ │ Agent Host (utility 进程) │
│ 链路 A：Copilot Chat   │ $handleProgress   │ ChatViewPane / ChatWidget    │  AHP 状态协议      │ 链路 B：新一代 agent      │
│ - participant / intent │ Chunk             │ ChatService / ChatModel      │                    │ - AgentService 编排器     │
│ - ToolCallingLoop      │                   │ ChatAgentService             │                    │ - AgentHostStateManager   │
│ - prompt-tsx           │                   │ LanguageModelToolsService    │                    │ - Copilot/Claude/Codex    │
│ - LM provider          │                   │ ChatEditingService           │                    │ - agent-host.db (SQLite)  │
│ - 补全 / NES           │                   │ PromptsService / MCP / 终端  │                    │ 主进程只管启动和崩溃重启  │
└────────────────────────┘                   └──────────────────────────────┘                    └──────────────────────────┘
```

- **链路 A**：请求先在渲染进程上屏，再 `activateByEvent('onChatParticipant:<id>')` 拉起扩展，扩展把流式结果打包回传。
- **链路 B**：`AgentHostSessionHandler` 在渲染进程中注册为 `isCore: true` 的动态 agent（`contrib/chat/browser/agentSessions/agentHost/agentHostSessionHandler.ts`），请求直接发到 agent host 进程；结果以 action 信封流回，由 `stateToProgressAdapter.ts` 转成与链路 A 相同的 `IChatProgress`，复用同一套 UI。

## 二、能力分层：什么在基座，什么在扩展

| 能力 | 基座（vscode 源码） | 扩展 / Agent Host | 备注 |
| --- | --- | --- | --- |
| 对话 UI 与布局 | `contrib/chat/browser/widget`、`widgetHosts/viewPane`、`chat.view.contribution.ts` | 无 | 视图容器注册在辅助侧栏，声明式 `SyncDescriptor` |
| 会话模型与持久化 | `common/model/chatModel.ts`、`chatSessionStore.ts`、`chatSessionOperationLog.ts` | agent host 自有 SQLite | 基座以追加式操作日志落盘 |
| 请求编排 | `common/chatService/chatServiceImpl.ts` | 无 | 上屏、收集上下文、选 agent、激活扩展、计时 |
| Agent 注册 | `common/participants/chatAgents.ts` | `package.json` 静态声明，激活后 `registerAgentImplementation` | 数据与实现分离，可「先显示后激活」 |
| 模型调用 | `common/languageModels.ts`（注册表与转发） | Copilot 扩展 / agent host SDK | 基座不直接发 HTTP |
| Agent 循环与 prompt | 无 | `extension/intents/node/toolCallingLoop.ts`、prompt-tsx | 唯一留在扩展里的重逻辑 |
| 工具系统 | `common/tools/languageModelToolsService.ts`、`builtinTools` | 扩展再注册 38 个工具 | 确认 UI、风险评估、结果压缩在基座 |
| 终端工具 | `terminalContrib/chatAgentTools` | 无 | runInTerminal、输出分析、自动批准 |
| 流式文件编辑 | `browser/chatEditing` | 扩展只发 `TextEdit` | 编辑直接写入内存 `TextModel` |
| MCP | `contrib/mcp`、`platform/mcp` | stdio 进程在扩展宿主或 agent host 中 | 注册表、授权、UI 在基座 |
| 提示文件 / skills / hooks | `common/promptSyntax` | 可配置为扩展收集 | `chat.experimental.collectInstructionsInExtension` |
| Inline Chat | `contrib/inlineChat` | 扩展提供 agent 实现 | 复用同一 `ChatService` |
| 代码补全 / NES | `contrib/inlineCompletions`（薄接入层） | `extension/completions`、`xtab`、`inlineEdits` | 仍在扩展中 |

## 三、性能关键机制

### A. 启动阶段：几乎什么都不做

- **服务懒实例化**：`chat.shared.contribution.ts:3386-3449` 中 64 个 `registerSingleton` 有 63 个是 `InstantiationType.Delayed`，只有语音转文字是 `Eager`。
- **按阶段注册 contribution**：66 个 `registerWorkbenchContribution2` 中，`BlockStartup` 6 个、`BlockRestore` 24 个、`AfterRestored` 20 个、`Eventually` 16 个。
- **静态声明先注册**：`chatParticipant.contribution.ts:107-310` 在 `BlockStartup` 阶段读取扩展 `package.json` 的 `chatParticipants` 并 `registerAgent(数据)`，界面立即可用；实现等扩展激活后再补上。
- **扩展未就绪也能先提交**：`chatSetup/chatSetupProviders.ts:304-400` 中的 `SetupAgent` 作为占位 agent。请求先上屏，并行等待 agent 激活、agent 就绪、模型就绪、工具就绪四个信号（本地 20s、远程 60s 超时，10s 时提示「Chat is almost ready」），就绪后转发。
- **扩展激活**：Copilot 使用 `onStartupFinished`；激活时只 `await` 声明了 `activationBlocker` 的 contribution，并记录每个 blocker 的耗时（`extensions/copilot/src/extension/common/contributions.ts`）。

### B. 发送请求：先上屏，再并行准备

- `chatServiceImpl.ts:1843-1852`：在任何 `await` 之前同步 `model.addRequest()`，请求立即显示（打点 `request/uiUpdated`）。
- `chatServiceImpl.ts:1855-1858`：`Promise.all([collectHooks(), collectInstructions()])` 并行收集；自动注入的 promptText（每条约 33 KB）只传给 agent，不写进模型、不持久化。
- `chatServiceImpl.ts:1971`：`activateByEvent('onChatParticipant:' + agent.id)`，只激活需要的扩展。
- `chatServiceImpl.ts:1700-1702`：第一次收到进度时打 `request/firstToken`。

### C. 跨进程流式传输：批量，而不是逐 token

- `api/common/extHostChatAgents2.ts:92-115`：`stream.markdown()` 只 push 进 `sendQueue`，队列从空变非空时 `queueMicrotask` 调度一次 `$handleProgressChunk`，同一 tick 的片段合成一次 RPC。
- `api/common/extHostLanguageModels.ts:318-335`：模型流式片段用 `RunOnceScheduler` 30ms 发送一次，积压超过 30 片立即发送；二进制走 `SerializableObjectWithBuffers`。
- `api/browser/mainThreadChatAgents2.ts:480`：主线程整批处理后统一调用 `progress(parts)`。

### D. UI 渲染：虚拟列表 + 按词速渐进渲染 + 编辑器池

- `widget/chatListWidget.ts:600-627`：对话列表是 `WorkbenchObjectTree`（`supportDynamicHeights`），只渲染可见行。
- `widget/chatListRenderer.ts:1083-1105` 与 `common/model/chatStreamStats.ts`：根据到达速率 `impliedWordLoadRate` 按 40～2000 词/秒逐步揭示文字，完成后至少 80 词/秒收尾，渲染节奏与网络解耦。
- `chatListRenderer.ts:2126`：新内容与已渲染部件做 diff，未变化的部件保留 DOM。
- `chatContentParts/chatContentCodePools.ts`：`EditorPool`、`DiffEditorPool` 复用 Monaco 编辑器实例。
- `chatContentParts/chatIncrementalRendering`：rAF 合批、仅追加的 markdown morph（实验中，`chat.experimental.incrementalRendering.enabled` 默认关闭）。

### E. 文件编辑与会话持久化

- `chatEditing/chatEditingTextModelChangeService.ts:177-300`：`acceptAgentEdits` 通过 `pushEditOperations` 写入内存模型，原始内容保存在 original 模型用于 diff，用户保留前不落盘。
- `common/model/chatSessionStore.ts:355-395`：`ChatSessionOperationLog` 只写增量，以追加模式写文件；所有写入由 `Sequencer` 串行化。

### F. Agent Host：把大脑移出扩展宿主

- `platform/agentHost/node/agentHostService.ts:30-90`：`AgentHostProcessManager` 在第一个连接请求时才启动 utility 进程（入口 `vs/platform/agentHost/node/agentHostMain`），负责崩溃重启，主进程不转发 agent 调用。
- `platform/agentHost/electron-browser/localAgentHostService.ts`：渲染进程 `acquirePort` 拿到直连端口。
- `platform/agentHost/common/state/`：AHP 协议，类似 Redux——服务端维护权威状态树，客户端订阅后先拿快照，再接收 `ActionEnvelope` 增量。
- `platform/agentHost/AGENTS.md`：会话列表只读中央 SQLite 目录；恢复时 peer chat 只登记摘要，订阅时才加载历史；后台维护推迟到 `startupSettled` 之后。
- `platform/agentHost/PERFORMANCE.md`：`bootstrap`、`hostReady`、`firstSessionList`、`startupSettled` 等启动里程碑。

## 四、社区的性能度量点

| 场景 | 起点 → 终点 | 位置 |
| --- | --- | --- |
| 输入到上屏 | `code/chat/<session>/request/start` → `request/uiUpdated` | `chatWidget.ts`、`chatModel.ts:3481` |
| 首 token | `request/start` → `request/firstToken` | `chatServiceImpl.ts:1701` |
| instructions 收集 | `request/willCollectInstructions` → `didCollectInstructions` | `chatServiceImpl.ts:1797、1815` |
| 冷启动等待扩展激活 | `code/chat/willWaitForActivation` → `didWaitForActivation` | `chatSetupProviders.ts:341` |
| Agent 调用往返 | `agent/willInvoke` → `agent/didInvoke` | `chatAgents.ts:548、556` |
| 扩展激活 | `willActivate` → `didActivate` | `extensions/copilot/src/util/common/performance.ts` |
| prompt 构建 / 模型请求 | `willBuildPrompt` → `didBuildPrompt`，`willFetch` → `didFetch` | 同上（每轮） |
| Agent host 启动 | `processStart` → `hostReady` → `firstSessionList` → `startupSettled` | `agentHostStartupPerformance.ts` |

打点使用 `vs/base/common/performance` 的 `mark()`，可以在「Developer: Startup Performance」中查看，也可以用 `performance.getMarks()` 导出。

## 五、插件方案的常见慢因对照

| 插件方案中常见做法 | 社区做法 | 影响 |
| --- | --- | --- |
| webview 画整个对话界面 | 原生 DOM + `WorkbenchObjectTree` + 编辑器池 | iframe 与独立文档的创建开销，所有交互都要 `postMessage` 往返 |
| `activationEvents: ["*"]` 或 `activate` 中同步初始化大量模块 | `onStartupFinished` + 静态贡献点 + `activationBlocker` | 占用扩展宿主启动时间 |
| 每个 token 一次 `postMessage` / RPC | 微任务合批 + 30ms 节流 | IPC 次数随 token 线性增长 |
| 每次更新整段 markdown 重渲染 | 渐进渲染 + 部件 diff + 增量 morph | 长回复卡顿 |
| 每次覆盖写整份会话 JSON | 追加式操作日志 + `Sequencer` | 会话越长写入越慢 |
| 扩展处理后才上屏 | `addRequest` 先同步上屏 | 输入延迟 |

## 六、版本差异（本仓库 1.113.0 与社区 1.143.0）

| 模块 | 本仓库 | 说明 |
| --- | --- | --- |
| `src/vs/platform/agentHost` | 有（约 9.5k 行） | 社区约 24.2 万行，协议与能力差距很大 |
| `contrib/chat/common/chatPerf.ts` | 无 | 需要自行移植打点定义 |
| `contrib/chat/browser/chatSetup` | 有 | |
| `chatContentParts/chatIncrementalRendering` | 无 | |
| `common/model/chatSessionOperationLog.ts` | 有 | |
| `common/model/chatStreamStats.ts` | 有 | |
| `src/vs/sessions` | 有 | |
| `extensions/copilot` | 无 | 社区后来才把 Copilot 扩展并入仓库 |
