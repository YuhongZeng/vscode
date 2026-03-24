# 原生流式代码建议 (Streaming Inline Completions) Spec

## Why
随着大语言模型在代码补全场景的广泛应用，传统的“一次性返回完整代码”无法满足用户极低延迟的体验要求。现有的 VS Code `InlineCompletionItemProvider` 默认不支持或无法稳定处理 `AsyncIterable` 类型的流式数据，导致流式生成时出现“闪烁、消失、中断”等现象。本需求旨在打通并修复 VS Code 核心架构中的流式处理链路，完美支持原生流式代码建议。

## What Changes
- 修复 `InlineCompletionsSource` 中的内存泄漏问题，正确销毁旧的 `InlineCompletionsState`。
- 放宽 `InlineCompletionsController` 中 UI 层的激进终止策略，移除因为微小光标变动或瞬间失焦而触发的 `stop()` 调用。

## Impact
- Affected specs: 流式内联建议 (Streaming Inline Completions) 渲染与生命周期管理
- Affected code: 
  - `inlineCompletionsSource.ts`
  - `inlineCompletionsController.ts`

## ADDED Requirements
### Requirement: 稳定渲染流式代码建议
系统应该能够平滑、稳定地逐字/逐行渲染由插件端返回的 `AsyncIterable` 流式代码建议，且不发生内存泄漏。

#### Scenario: 成功处理高频流式更新
- **WHEN** 插件端高频返回流式代码块 (chunk) 时
- **THEN** 系统替换旧状态前应正确调用 `dispose()` 释放内存，保证内存不泄漏。

### Requirement: 精准的流式状态透传
系统需要在 RPC 层 (`IdentifiableInlineCompletions`) 显式增加 `isStreaming: boolean` 字段，使前端控制器能够准确判断当前是否在流式传输状态。

### Requirement: 防抖失焦检测 (Debounced Blur Detection)
系统需要在失去焦点时引入防抖机制（例如 50-100ms），以过滤掉由于 UI 渲染（如 Suggest Widget 弹出）引起的假性瞬间失焦，避免模型被意外杀死。

### Requirement: 流式 Diff 与合并算法优化
在 `computeGhostText` 计算中引入增量计算 (Incremental Diff)，针对最新到达的流式 chunk 进行解析和渲染，降低前端 CPU 消耗，支持长达几百行的代码生成。

### Requirement: 兼容性保证 (Backward Compatibility)
**必须确保** 所有的优化和修改不仅能够让流式建议完美工作，也不能破坏原有的非流式（静态）代码建议功能。无论插件端返回的是普通的补全结果还是 `AsyncIterable`，系统都应正常渲染和响应交互。

## MODIFIED Requirements
### Requirement: 优化流式建议的终止策略
**修改前**: 光标发生任何显式移动或编辑器短暂失焦时，立刻停止建议生成 (`model.stop()`)。
**修改后**: 放宽终止条件，在流式传输生命周期内，避免由于渲染第一帧引起的 UI 布局重排（如短暂失焦）或无关紧要的光标变动打断代码生成。
