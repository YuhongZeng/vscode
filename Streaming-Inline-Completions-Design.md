# VS Code 原生流式代码建议 (Streaming Inline Completions) 实现与优化文档

## 1. 需求背景
随着 LLM（大语言模型）在代码补全场景的广泛应用，传统的“一次性返回完整代码（Static Completion）”已无法满足用户对极低延迟的体验要求。用户期望在 AI 生成代码的过程中，能够像打字机一样**实时、逐字/逐行地看到（流式）生成结果**（即 Streaming Ghost Text）。
现有的 VS Code `InlineCompletionItemProvider` 默认不支持或无法稳定处理 `AsyncIterable` 类型的流式数据，导致在流式生成时经常出现“闪烁、消失、中断”等现象。本需求旨在打通并修复 VS Code 核心架构中的流式处理链路，使其完美支持原生的流式代码建议。

## 2. 核心问题与修复思路

在实现和排查过程中，我们发现了阻碍流式生成的两个核心瓶颈，并针对性地进行了修复：

### 2.1 扩展宿主 (Extension Host) 的生命周期与内存泄漏问题
- **问题现象**：当插件返回 `AsyncIterable` 时，主线程很快抛出 `LEAKED DISPOSABLE` 内存泄漏错误，并且流式循环被异常截断。
- **根本原因**：`InlineCompletionsSource` 在接收流式更新 (chunk) 并替换旧的 `InlineCompletionsState` 时，没有正确销毁（`dispose()`）前一个状态。由于高频的流式更新，瞬间堆积了大量的未释放对象，导致内存泄漏和内部状态机崩溃。
- **解决思路**：在状态更新事务中，显式调用 `v.inlineCompletions.dispose()` 和 `v.suggestWidgetInlineCompletions.dispose()`，确保每一个流式帧在被新帧替换时都能干净地释放内存。

### 2.2 UI 层的“误杀” (Aggressive Model Cancellation)
- **问题现象**：流式生成只能看到第一帧（跳动一下），然后 Ghost Text 就彻底消失了。
- **根本原因**：VS Code 的 `InlineCompletionsController` 原本是为静态建议设计的。它有两个非常激进的终止策略：
  1. **光标变化检测**：只要检测到光标有显式移动，就调用 `m.stop()`。
  2. **焦点变化检测**：只要编辑器失去焦点（哪怕是极其微小的 DOM 渲染导致的瞬间失焦），就调用 `m.stop('automatic')`。
  由于流式渲染第一帧时，极易引发 UI 布局重排（如 Suggest Widget 弹出）导致短暂失焦，从而触发了 `stop()`，直接把状态置为 `_isActive = false`，后续的所有流式数据全部被静默丢弃。
- **解决思路**：放宽前端控制器的终止条件。在 `inlineCompletionsController.ts` 中，移除了在 `ghostText` 状态下因为微小光标变动或瞬间失焦而触发的 `stop()` 调用。保证在流式传输生命周期内，生成过程不会被底层 UI 事件轻易打断。

## 3. 为什么这么实现 (设计思路)

1. **顺应现有架构而非推翻重来**：VS Code 已经具备了处理 `AsyncIterable` 的底层 RPC 桥接 (`extHostLanguageFeatures.ts` -> `mainThreadLanguageFeatures.ts`)。我们的设计思路是**疏通现有管道**，而不是去造一个新轮子。
2. **状态驱动 (Observable-based)**：VS Code 的 UI 渲染完全依赖于 Observable 状态机。流式建议的本质就是**高频地推入新状态**。只要我们确保 `InlineCompletionsModel` 的 `_isActive` 不被意外关闭，视图层 (`GhostTextView`) 就能自动根据最新的 `ghostTexts` 状态响应式地渲染出打字机效果。
3. **体验优先 (UX First)**：AI 代码生成的体验不应该被编辑器的内部焦点抖动打断。保留流的生命周期，把“是否终止流”的决定权更多地交还给用户的明确行为（如按下 `Esc`，或者直接输入破坏性字符）以及插件端（取消 Token）。

## 4. 风险点评估

1. **焦点失控风险 (Focus Loss Risk)**
   - *风险*：我们放宽了 `onDidBlurEditorWidget` 时的 `stop()` 逻辑。这可能导致用户在极其特殊的操作下（比如切换到了另一个完全不相关的 VS Code 窗口面板），幽灵文本依然残留在原编辑器中。
   - *缓解措施*：目前保留了对其他实例的互斥清理。后续如果发现残留问题，可以引入防抖 (debounce) 的失焦检测，而不是瞬间杀死。
2. **光标变动风险 (Cursor Change Risk)**
   - *风险*：取消了光标显式改变时的 `stop()`，意味着如果用户在流式生成中途用鼠标强行点击了别的地方，流式内容可能会尝试在新的位置继续生成（或报错）。
   - *缓解措施*：模型层内部对 `position` 有校验，如果不匹配当前光标，`computeGhostText` 会返回 `undefined` 从而不渲染。

## 5. 优化方案与未来优化思路

### 5.1 当前已实施的优化
- **消除内存泄漏**：严格管理 `InlineCompletionsState` 的 Disposable 生命周期，使得流式生成哪怕包含成百上千个 chunk，也不会造成内存压力。
- **平滑的视觉体验**：消除了因为 UI 焦点抖动导致的闪烁和中断，实现了真正的平滑流式输出。

### 5.2 未来的优化重点 (Next Steps)
1. **精准的流式状态透传 (State Propagation)**：
   - *思路*：目前我们在前端控制器中难以准确拿到 `isStreaming` 状态。未来应该在 RPC 层 (`IdentifiableInlineCompletions`) 显式增加一个 `isStreaming: boolean` 字段。
   - *目的*：这样控制器就可以写出更优雅的逻辑：`if (!isStreaming && isFocused === false) { model.stop(); }`，既保护了流式生成，又保留了静态建议的失焦即焚特性。
2. **防抖失焦检测 (Debounced Blur Detection)**：
   - *思路*：不要在 `isFocused` 变为 `false` 的第一毫秒就杀死模型。可以使用 `setTimeout` 等待 50-100ms，如果焦点确实移走了，再执行 `stop()`。这能有效过滤掉 UI 渲染引起的假性失焦。
3. **流式 Diff 与合并算法优化**：
   - *思路*：目前每一个流式 chunk 到达，`computeGhostText` 都会对全量文本进行一次计算。
   - *重点*：当生成长达几百行的代码时，前端 CPU 消耗会增加。未来可以优化为增量计算 (Incremental Diff)，只对最新到达的 chunk 进行解析和渲染附加。

## 6. 总结
本次核心架构的打通，成功使 VS Code 具备了极高可用性的原生流式内联建议能力。通过修复内存泄漏和优化控制器的激进拦截机制，保障了高频数据流的稳定渲染，为接入高性能 LLM 打下了坚实的基础。
