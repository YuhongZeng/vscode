# VS Code Chat Editing API (`vscode.proposed.chatEditing.d.ts`) 使用指南

本指南面向 VS Code 扩展开发者，详细介绍了处于提案阶段（Proposed）的 `chatEditing` API。该 API 主要用于构建 AI 辅助编程功能，提供了一套原生的会话管理机制，用于应用代码修改并让用户进行可视化 Review（如 Multi-File Diff 视图）。

> **注意**: 此为 Proposed API，仅在 Insiders 版本中可用，且需要在 `package.json` 中配置 `"enabledApiProposals": ["chatEditing"]`。

---

## 目录
1. [核心概念](#核心概念)
2. [API 结构详解](#api-结构详解)
3. [典型使用场景与代码示例](#典型使用场景与代码示例)
4. [异常处理机制](#异常处理机制)
5. [UI 交互说明](#ui-交互说明)

---

## 核心概念

`chatEditing` API 的核心围绕 **Chat Editing Session（聊天编辑会话）** 展开。
当你的 AI Agent 想要对用户的工作区进行修改时，不再直接使用 `vscode.workspace.applyEdit()`，而是应该通过创建一个 `ChatEditingSession`。

通过 Session 管理修改有以下好处：
- **生命周期管理**：自动追踪所有被修改的文件状态（Modified, Accepted, Rejected）。
- **原生 UI 集成**：支持一键唤起多文件 Diff 视图（Multi-File Diff Editor），用户体验统一。
- **安全的落盘与回滚**：支持对只读文件、锁定文件等异常情况的优雅处理和自动状态回滚。

---

## API 结构详解

### 1. 启动会话：`startEditingSession`

创建或获取一个编辑会话。

```typescript
export interface ChatEditingSessionOptions {
    /** 
     * 可选参数，将当前编辑会话绑定到特定的聊天对话 ID。
     * 这有助于在 UI 上将代码修改与特定的聊天上下文关联。
     */
    chatSessionId?: string;
}

export function startEditingSession(options?: ChatEditingSessionOptions): Thenable<ChatEditingSession>;
```

### 2. 会话管理：`ChatEditingSession`

代表当前处于激活状态的代码修改会话。

```typescript
export interface ChatEditingSession extends Disposable {
    /** 会话的唯一 ID */
    readonly id: string;
    
    /** 会话中涉及的所有文件列表及其当前状态 */
    readonly files: readonly ChatEditingFile[];

    /** 当会话文件列表或文件状态发生改变时触发 */
    readonly onDidChange: Event<void>;

    /** 会话被清理时触发 */
    readonly onDidDispose: Event<void>;

    /**
     * 将批量编辑（WorkspaceEdit）应用到当前会话中。
     * 这一步会修改内存中的文件，并尝试将更改落盘。
     * @param edit 包含修改内容的 WorkspaceEdit
     * @param description 可选的描述信息
     * @returns 包含成功与否及错误详情的结果对象
     */
    applyEdits(edit: WorkspaceEdit, description?: string): Thenable<ChatEditingSessionApplyEditsResult>;

    /**
     * 接受会话中的修改（将状态从 Modified 变为 Accepted）。
     * 如果不传 uris，则接受所有修改。
     */
    accept(uris?: Uri[]): Thenable<void>;

    /**
     * 拒绝会话中的修改（将状态从 Modified 变为 Rejected 并撤销修改）。
     * 如果不传 uris，则拒绝所有修改。
     */
    reject(uris?: Uri[]): Thenable<void>;

    /**
     * 打开多文件 Diff 编辑器（DiffView），向用户展示当前的修改对比。
     * @param title 视图的标题
     */
    show(title?: string): Thenable<void>;
}
```

### 3. 文件状态：`ChatEditingFile`

```typescript
export enum ChatEditingFileState {
    Modified = 0, // 文件已被修改，等待用户确认
    Accepted = 1, // 修改已被用户或程序接受
    Rejected = 2  // 修改已被用户或程序拒绝（并回滚）
}

export interface ChatEditingFile {
    readonly uri: Uri;                    // 文件资源定位符
    readonly state: ChatEditingFileState; // 当前状态
    readonly isNew: boolean;              // 是否是本次会话中新创建的文件
    readonly added: number;               // 增加的行数统计
    readonly removed: number;             // 删除的行数统计
}
```

### 4. 异常反馈：`ChatEditingSessionApplyEditsResult`

处理文件 I/O 失败（如只读文件拦截）的结构化结果。

```typescript
export interface ChatEditingSessionApplyEditsResult {
    /** 是否全部应用成功。false 代表至少有一个文件保存失败。 */
    readonly success: boolean;
    
    /** 
     * 宏观错误摘要，适合直接打印日志或展示给人类用户看。
     * 示例: "Failed to save one or more files to disk."
     */
    readonly errorMessage?: string;
    
    /** 
     * 微观错误详情，精确到具体文件和系统错误。
     * 适合大模型 Agent 读取后进行自我纠正（Self-Correction）。
     */
    readonly failedEdits?: { readonly uri: Uri; readonly reason: string }[];
}
```

---

## 典型使用场景与代码示例

### 场景：大模型 Agent 收到用户请求，重构代码并展示 Diff 视图

```typescript
import * as vscode from 'vscode';

export async function executeAiRefactoring(chatSessionId: string) {
    // 1. 启动并绑定编辑会话
    const session = await vscode.chat.startEditingSession({ chatSessionId });

    // 2. 模拟大模型生成的代码修改
    const edit = new vscode.WorkspaceEdit();
    const targetFile = vscode.Uri.file('/path/to/workspace/app.ts');
    
    // 在第一行插入代码
    edit.replace(targetFile, new vscode.Range(0, 0, 0, 0), 'import { Logger } from "./logger";\n');

    // 3. 将修改应用到会话中
    const result = await session.applyEdits(edit, "Add Logger Import");

    // 4. 处理应用结果
    if (!result.success) {
        // 如果失败（例如目标文件是只读的）
        console.error(result.errorMessage);
        
        if (result.failedEdits) {
            // 大模型可以遍历失败详情，决定是否重试或告诉用户
            for (const failure of result.failedEdits) {
                console.warn(`File: ${failure.uri.fsPath}, Reason: ${failure.reason}`);
            }
        }
        
        // 注意：底层 API 会自动将保存失败的文件回滚（Reject），不会留下脏状态
        return;
    }

    // 5. 修改成功应用后，唤起 Diff 视图让用户进行 Review
    await session.show("Review AI Refactoring");

    // 6. 监听用户操作状态（可选）
    const disposable = session.onDidChange(() => {
        const allAccepted = session.files.every(f => f.state === vscode.chat.ChatEditingFileState.Accepted);
        if (allAccepted) {
            vscode.window.showInformationMessage("用户已接受所有 AI 修改！");
            disposable.dispose();
        }
    });
}
```

---

## 异常处理机制

在传统的 `workspace.applyEdit` 中，如果修改了只读文件，VS Code 往往会弹出一个原生的系统警告框要求用户选择是否覆盖，这会打断 AI 自动化的流程。

而在 `ChatEditingSession.applyEdits` 中：
1. **静默拦截**：底层会自动抑制原生的覆盖警告弹框。
2. **自动回滚**：如果文件保存到磁盘失败，API 会自动将该文件在内存中的脏状态（Dirty State）清除，执行相当于 `session.reject()` 的操作。
3. **结构化返回**：通过返回值的 `failedEdits` 数组，将失败的 URI 和底层错误（如 `EPERM: operation not permitted`）抛给上层扩展，由扩展的大模型来决定如何处理。

---

## UI 交互说明

通过该 API 修改代码后，VS Code 会提供原生的 UI 支持：
- **DiffView**：调用 `session.show()` 会打开一个类似合并冲突或 Git 提交界面的 Multi-File Diff 编辑器。
- **操作按钮**：在 Diff 视图中，用户可以针对每个文件独立点击 `Accept`（接受）或 `Discard`（拒绝）。
- **Overlay Widget**：在普通代码编辑器中，被修改的文件底部会显示一个小挂件，提示用户该文件已被 AI 修改，并提供接受/拒绝按钮。
- 用户点击这些原生 UI 按钮时，API 底层会自动调用 `session.accept()` 或 `session.reject()`，并触发 `session.onDidChange` 事件。扩展通常不需要手动去调用 accept/reject，只需监听状态变化即可。
