# 流式内联补全架构重构 Spec (Streaming Inline Completions Architecture Refactoring)

## 背景与目标 (Why)
目前的流式内联补全实现是在原有的“静态单次补全”架构上进行修补（Patching）。由于静态补全模型假设代码前缀是固定且脆弱的，任何结构性文本变更（如换行）或微小的光标移动都会导致模型状态（`versionId` 或 `itemToPreserve`）失效，从而触发暴力的状态清除。这种架构上的不匹配导致了流式生成极易被打断（换行丢失）或失控（光标逃逸继续生成代码错位）。

我们的目标不只是修复这些表面 Bug，而是**从根本上重构流式内联补全的状态流转与生命周期管理**，将其提升为一等公民（First-class Citizen）。通过引入独立的流式会话管理机制，彻底解决并发控制、增量更新和用户交互冲突问题。

## 核心架构重构设计 (What Changes)

### 1. 引入独立的 `StreamingInlineCompletionsSession`
不再让流式补全依附于脆弱的静态 `InlineCompletionsState`。
- **职责**：专门负责管理一个长期存活的流式请求生命周期。
- **状态追踪**：维护一个动态的 **“幽灵锚点 (Ghost Anchor)”**。当流式数据到达时，锚点向后延伸；当用户顺着提示打字（包括换行）时，锚点向前消费，而不会因为 `versionId` 变化而直接销毁整个会话。

### 2. 重构文本变更策略 (Mutable Text Anchor)
**从“精确前缀匹配”改为“流式前缀消费”：**
- **当前逻辑**：一旦文档内容改变（`handleChange`），如果新的前缀与最初请求时的前缀不完全匹配，直接丢弃补全。
- **重构逻辑**：在 `Streaming Session` 中，如果用户的输入（例如按下了 Enter 换行）与当前已经接收到的流式 Ghost Text 的前几个字符/行匹配，我们将这些字符标记为“已确认 (Accepted)”，并截断流式缓冲区的前缀，保留剩余的流式连接继续接收数据。

### 3. 重构光标逃逸边界 (Cursor Escape Boundary)
**从“全盘放行”改为“动态合法区域 (Valid Cursor Zone)”：**
- **当前逻辑**：为了防止假性失焦断流，粗暴地通过 `if (isStreaming) return;` 屏蔽了所有光标移动导致的 `stop()`。
- **重构逻辑**：定义一个动态计算的 `Valid Cursor Zone`（通常是当前 Ghost Text 的起始位置到当前光标位置的连续区间）。
  - 当触发 `onDidChangeCursorPosition` 且 `reason === Explicit` 时，检查新光标位置。
  - **如果在 Zone 内**（例如用户用方向键在已生成的 Ghost Text 中移动），保持流式。
  - **如果逃逸出 Zone**（例如点击了上一行），立即销毁 `Streaming Session` 并发送 `cancel()`。

## 改进后的系统架构与状态机流程图 (Architecture & State Machine)

### 核心状态机设计 (Streaming Session FSM)
```text
[ Idle ] 
   | (User Types / Trigger)
   v
[ Fetching Initial Chunk ] ---> (Timeout / Cancel) ---> [ Idle ]
   | (First Yield Arrives)
   v
[ Streaming Active ] 
   |
   |--- (User Types Matching Prefix) ---> 消费前缀，更新 Anchor，保持 [ Streaming Active ]
   |
   |--- (User Types Non-Matching)    ---> 触发冲刷，销毁 Session ---> [ Idle ]
   |
   |--- (Explicit Cursor Escape)     ---> 触发 cancel()，销毁 Session ---> [ Idle ]
   |
   |--- (Stream Exhausted)           ---> 转换为普通静态补全 ---> [ Static Resolved ]
```

### 并发控制逻辑
- **多请求抢占**：同一时刻只允许存在一个 `Streaming Active` 会话。新触发的补全请求必须先调用前一个会话的 `dispose()`。
- **CancellationToken 绑定**：将会话的生命周期与底层的 RPC `CancellationToken` 深度绑定，确保 `dispose()` 时扩展宿主 (ExtHost) 能够立即停止网络请求或本地大模型推理，释放 CPU/GPU 资源。

## 核心模块的接口定义

```typescript
// 新增流式会话接口
interface IStreamingCompletionSession extends IDisposable {
    readonly state: 'fetching' | 'streaming' | 'completed' | 'cancelled';
    readonly ghostAnchor: Position; // 当前流式文本挂载的动态起点
    
    // 尝试消费用户输入，如果匹配则返回 true，否则返回 false
    tryConsumeInput(textChange: string): boolean;
    
    // 检查光标是否逃逸
    isCursorEscaped(newPosition: Position, reason: CursorChangeReason): boolean;
}
```

## 单元测试、集成测试用例及性能基准

### 测试用例
1. **多行顺畅输入测试 (Multiline Flow Test)**
   - 模拟模型返回：`const a = 1;\nconst b = 2;`
   - 用户操作：输入 `const a = 1;` 后按下 `Enter`。
   - 预期结果：状态机保持 `Streaming Active`，`const b = 2;` 继续作为 Ghost Text 显示在下一行，不发生闪烁或丢数据。
2. **光标逃逸拦截测试 (Escape Interception Test)**
   - 模拟模型正在疯狂输出 100 行代码。
   - 用户操作：使用鼠标点击文档的第 1 行（远离生成区）。
   - 预期结果：状态机立即转移至 `Idle`，并在 100ms 内触发扩展宿主的 `CancellationToken.isCancellationRequested`。
3. **乱序输入回滚测试 (Chaotic Input Rollback Test)**
   - 用户在 Ghost Text 内部输入了与推荐完全无关的字符。
   - 预期结果：当前 Session 销毁，触发全新一轮补全请求。

### 性能基准
- **换行数据保留率**：≥ 99% 场景下，用户输入匹配的换行符时，内存中的流式 Buffer 不被丢弃。
- **逃逸中断延迟**：从触发光标显式变更到发送 Cancel 信号的端到端延迟 ≤ 100ms。

## 上线验证 Checklist 与灰度回滚策略

**灰度策略**：
- 引入新的配置项 `editor.inlineCompletions.streamingArchitecture: "refactored" | "legacy"`。
- 默认在 Insiders 版本开启 `refactored`，保留旧版逻辑作为安全垫。
- **回滚条件**：如果收到超过 5 例“幽灵代码无法删除”或“打字卡顿严重”的 Issue，通过 Settings Sync 统一切换回 `legacy`。
