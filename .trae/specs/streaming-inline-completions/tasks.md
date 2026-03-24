# Tasks
- [x] Task 1: 修复扩展宿主生命周期与内存泄漏问题
  - [x] SubTask 1.1: 修复 `inlineCompletionsSource.ts` 状态更新事务中未显式调用 `v.inlineCompletions.dispose()` 导致的内存泄露问题。
  - [x] SubTask 1.2: 修复 `inlineCompletionsSource.ts` 状态更新事务中未显式调用 `v.suggestWidgetInlineCompletions.dispose()` 导致的内存泄露问题。
- [x] Task 2: 修复 UI 层激进的模型终止策略
  - [x] SubTask 2.1: 在 `inlineCompletionsController.ts` 中移除因为瞬间失焦而触发的 `stop('automatic')` 逻辑（针对 ghostText 状态）。
  - [x] SubTask 2.2: 在 `inlineCompletionsController.ts` 中移除因为微小光标变动而触发的 `stop()` 逻辑。
- [x] Task 3: 实现精准的流式状态透传 (State Propagation)
  - [x] SubTask 3.1: 在 RPC 层的 `IdentifiableInlineCompletions` 接口及相关实现中添加 `isStreaming: boolean` 字段。
  - [x] SubTask 3.2: 更新前端控制器逻辑，仅在 `!isStreaming && isFocused === false` 时才执行 `model.stop()`，保护流式生成并保留静态建议的失焦即焚特性。
- [x] Task 4: 实现防抖失焦检测 (Debounced Blur Detection)
  - [x] SubTask 4.1: 在 `inlineCompletionsController.ts` 中引入 `setTimeout` 等待机制 (50-100ms)，过滤掉 UI 渲染导致的假性失焦。
- [x] Task 5: 优化流式 Diff 与合并算法
  - [x] SubTask 5.1: 修改 `computeGhostText` 的逻辑，针对增量 chunk 实现增量计算 (Incremental Diff)，减少全量重新计算。
- [x] Task 6: 功能回归与兼容性测试
  - [x] SubTask 6.1: 验证插件端返回 `AsyncIterable` 时，流式打字机效果、中断和多行支持正常工作且无内存泄漏。
  - [x] SubTask 6.2: 验证插件端返回非流式（静态）补全结果时，功能完全正常，没有被上述优化逻辑破坏。

# Task Dependencies
- Task 1 和 Task 2 可并行处理。
- Task 3 依赖于底层 RPC 数据结构的修改。
- Task 4 可以在 Task 2 的基础上进行调整。
- Task 5 独立，可并行处理。
