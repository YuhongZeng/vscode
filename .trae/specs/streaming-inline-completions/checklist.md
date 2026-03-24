\*- \[x] `inlineCompletionsSource.ts` 中替换新旧状态时，确保旧的 `inlineCompletions` 和 `suggestWidgetInlineCompletions` 已被正确 `dispose()` 以防止内存泄漏。

* [x] `inlineCompletionsController.ts` 中失焦事件 (`onDidBlurEditorWidget`) 不再立即打断流式建议的生成（即不再执行 `stop('automatic')` 逻辑）。

* [x] `inlineCompletionsController.ts` 中轻微的光标移动不再轻易触发流式建议的终止。

* [x] RPC 层的 `IdentifiableInlineCompletions` 及相关类型已添加并传递了 `isStreaming: boolean` 状态。

* [x] 控制器在处理失焦时，通过 `isStreaming` 状态区分静态和流式建议，仅对静态建议保留失焦即焚特性。

\*- \[x] 失焦检测已引入 `setTimeout` 防抖机制，有效过滤了瞬间假性失焦。

* [x] `computeGhostText` 已引入流式 Diff，针对新 chunk 执行增量计算而非全量计算。

* [x] 测试验证：流式建议 (Streaming) 的各种场景（打字机、中断、焦点切换）均表现正常。

* [x] 测试验证：非流式静态建议 (Non-streaming) 的功能表现正常，完全不受优化修改的影响。

