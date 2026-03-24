# 优化测试插件流式生成速度 (Plan)

## 1. 缺陷分析与当前状态 (Current State Analysis)

### 缺陷描述
用户反馈流式生成有点慢。

### 当前状态
在 `streaming-inline-completions-test/src/extension.ts` 的流式生成模拟实现中：
```typescript
if (streamIndex < fullText.length) {
	setTimeout(() => {
		if (!token.isCancellationRequested) {
			currentText += fullText[streamIndex];
			streamIndex++;
			onDidChangeEmitter.fire({ data: { streaming: true } });
		} else {
			console.log("Token cancelled, stopping stream.");
			isStreamingMode = false;
		}
	}, 30);
}
```
当前逻辑是**每隔 30ms** 仅生成**单个字符 (`fullText[streamIndex]`)**。由于 `fullText` 是一段长约百余个字符的多行代码，每秒仅能输出约 33 个字符，导致整体视觉感受上的“打字机”效果非常缓慢。

## 2. 提议的变更方案 (Proposed Changes)

**目标文件**：`streaming-inline-completions-test/src/extension.ts`

### 修改点 1：增大单次生成的 Chunk 大小 (Increase Chunk Size)
不再逐个字符 (1 char/tick) 生成，而是改为每次生成 3~5 个字符，或者通过一个随机数控制生成长度，使得效果更贴近真实大模型的词元 (Token) 级别的输出速度。

### 修改点 2：缩短/调整延时 (Decrease Latency)
将 `setTimeout` 的时间从 30ms 稍微调低（如 15~20ms），或配合 Chunk 大小进行动态调整。

**拟定代码逻辑**：
```typescript
if (streamIndex < fullText.length) {
	setTimeout(() => {
		if (!token.isCancellationRequested) {
			// 每次生成 1 到 5 个字符，模拟真实 Token 长度
			const chunkSize = Math.floor(Math.random() * 5) + 1;
			currentText += fullText.slice(streamIndex, streamIndex + chunkSize);
			streamIndex += chunkSize;
			onDidChangeEmitter.fire({ data: { streaming: true } });
		} else {
			// ...
		}
	}, 15); // 将延迟降低至 15ms
}
```

## 3. 假设与决策 (Assumptions & Decisions)
- **假设**：测试插件的目的是验证 VS Code 核心的流式处理能力。较快的流速也能更好地进行并发控制和防抖机制（Debounce）的压力测试。
- **决策**：引入随机长度的 Chunk 和降低定时器延迟，这样既保留了流式的渐进输出特性，又能显著提升整体生成完成的速度。

## 4. 验证步骤 (Verification Steps)
1. 修改 `streaming-inline-completions-test/src/extension.ts`。
2. 运行 `npm run compile` 确保编译通过。
3. 重新加载 VS Code 测试窗口，触发 `Trigger Streaming Inline Completion`，观察生成速度是否明显加快且视觉效果平滑。