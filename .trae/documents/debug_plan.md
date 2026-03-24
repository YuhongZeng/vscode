# Debugging Plan for Streaming Inline Completions

## 1. 摘要 (Summary)
用户反馈流式内联建议“一直在循环”且显示“Accept”按钮，但没有显示建议内容（Ghost Text）。这表明数据流可能已经打通，但渲染层或数据转换层存在问题。本计划将通过在关键节点添加日志（Logging）来追踪数据流向，定位数据丢失或 UI 未更新的原因。

## 2. 现状分析 (Current State Analysis)
- **现象**: 插件触发流式命令后，Extension Host 处于循环状态（说明流正在生成）。UI 显示“Accept”操作（说明 VS Code 认为有建议），但看不到文本（Ghost Text 不可见）。
- **可能原因**:
  1. `InlineSuggestionItem` 的 `insertText` 为空或 `range` 无效。
  2. `toInlineSuggestData` 转换失败导致建议列表为空（但这样“Accept”不应显示）。
  3. `InlineCompletionsSource` 更新了状态，但 `GhostTextWidget` 未能检测到变化或渲染了空文本。
  4. `AsyncIterable` 传输过程中数据丢失。

## 3. 调试步骤 (Debugging Steps)

### 3.1 添加日志 (Add Logging)
将在以下文件中添加 `console.log` 以追踪数据：
- **`extHostLanguageFeatures.ts`**: 确认插件返回的 `AsyncIterable` 是否产生了有效数据，以及 RPC 是否发送了 `insertText`。
- **`mainThreadLanguageFeatures.ts`**: 确认主进程是否收到了 RPC 数据并写入了流。
- **`provideInlineCompletions.ts`**: 确认内核层是否从流中读取到了数据，并生成了 `InlineSuggestionList`。
- **`inlineCompletionsSource.ts`**: 确认是否进入了 `for await` 循环，以及 `this.inlineCompletions.set` 是否被调用，且包含有效的建议项。

### 3.2 编译与运行 (Compile & Run)
- 运行 `npm run gulp compile` 重新编译。
- 指导用户启动 VS Code (Source)，打开开发者工具 (Developer Tools) 和 Extension Host 输出窗口。
- 触发插件命令，观察日志输出。

### 3.3 分析与修复 (Analyze & Fix)
- 根据日志定位断点：
  - 如果 ExtHost 有数据但 MainThread 无：RPC 传输问题。
  - 如果 MainThread 有数据但 Source 无：`AsyncIterableProducer` 或 `provideInlineCompletions` 逻辑问题。
  - 如果 Source 有更新但 UI 无变化：`GhostTextWidget` 或 `InlineCompletionsModel` 更新机制问题，或者 `range`/`text` 数据问题。

## 4. 验证 (Verification)
- 修复后，移除日志。
- 再次运行插件，确认流式逐字显示正常。

## 5. 拟议修改 (Proposed Changes for Debugging)
*(Files to be modified with logging statements)*
- `src/vs/workbench/api/common/extHostLanguageFeatures.ts`
- `src/vs/workbench/api/browser/mainThreadLanguageFeatures.ts`
- `src/vs/editor/contrib/inlineCompletions/browser/model/provideInlineCompletions.ts`
- `src/vs/editor/contrib/inlineCompletions/browser/model/inlineCompletionsSource.ts`
