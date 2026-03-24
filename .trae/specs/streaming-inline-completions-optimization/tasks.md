# Tasks

- [x] Task 1: 架构重构 - 剥离流式会话管理 (Extract Streaming Session)
  - [x] SubTask 1.1: 在 `inlineCompletionsModel.ts` 或相邻目录中创建 `StreamingInlineCompletionsSession` 类，专门负责管理流式生命周期。
  - [x] SubTask 1.2: 将原先耦合在静态 `InlineCompletionsState` 中的 `isStreaming` 逻辑转移至独立的流式会话中。
  - [x] SubTask 1.3: 重构 `inlineCompletionsSource.ts`，使其能够生成并持有 `Streaming Session`，并将 `CancellationToken` 与 Session 绑定。

- [x] Task 2: 实现流式前缀消费与换行保留 (Mutable Text Anchor & Newline Retention)
  - [x] SubTask 2.1: 实现 `tryConsumeInput(textChange)` 算法。当监听到 `onDidChangeContent` 时，如果用户的变更（含换行）完全匹配当前的流式 Buffer 前缀，则推进 `ghostAnchor`，截断 Buffer。
  - [x] SubTask 2.2: 在 `InlineCompletionsModel.handleChange` 中接入上述逻辑，如果消费成功，则绕过传统的 `versionId` 校验和暴力 `dispose()`。

- [x] Task 3: 实现动态光标合法区域与逃逸打断 (Dynamic Valid Cursor Zone & Escape Interruption)
  - [x] SubTask 3.1: 在 `Streaming Session` 中实现 `isCursorEscaped` 算法，定义合法区域为 `[ghostAnchor, ghostTextEnd]`。
  - [x] SubTask 3.2: 在 `inlineCompletionsController.ts` 中，监听 `onDidChangeCursorPosition`。如果 `reason === Explicit` 且触发逃逸，立即调用 `Session.cancel()`。

- [x] Task 4: UI 渲染层对接与状态机同步 (UI Binding & FSM Sync)
  - [x] SubTask 4.1: 更新 `computeGhostText` 和 `GhostTextView`，使其能够正确读取并渲染 `Streaming Session` 中的增量文本与截断后的 Buffer。
  - [x] SubTask 4.2: 处理 Session `Completed` 事件，将其平滑转换为普通的静态 `InlineCompletionsState` 以供后续采纳 (Accept) 操作使用。

- [x] Task 5: 验证与测试 (Validation & Testing)
  - [x] SubTask 5.1: 升级 `streaming-inline-completions-test` 插件，模拟复杂的换行生成场景。
  - [x] SubTask 5.2: 针对多行顺畅输入、光标逃逸拦截、乱序输入回滚编写自动化测试或进行系统性的手工回归验证。

# Task Dependencies
- Task 1 是基础架构铺垫，必须最先完成。
- Task 2 和 Task 3 是核心算法重构，依赖于 Task 1 建立的 Session 模型。
- Task 4 负责将后端的重构连接到前端 UI，依赖于 Task 1, 2, 3。
- Task 5 贯穿始终，但主要在架构重构落地后进行整体验证。
