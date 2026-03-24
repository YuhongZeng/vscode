# Plan: Optimize Chat Editing Interface and Plugin

## Goal

1. **Optimize** **`vscode.proposed.chatEditing.d.ts`** **&** **`ai-diff-extension-sample`**:

   * Enable restoring previous `EditingSession`s and maintaining them across window reloads.

   * Support multiple concurrent sessions in the extension.

   * Allow switching between sessions (via Tree View hierarchy).

   * Display file changes for each session.

   * Automatically remove files from the Tree View when they are confirmed (Accepted/Rejected).
2. **Optimize** **`chatEditingEditorOverlay.ts`**:

   * Update the overlay widget to display the current file index and total file count (e.g., "File 1 / 3") alongside the existing change counter.

## Steps

### 1. VS Code Core: Chat Editor Overlay

**File**: `src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingEditorOverlay.ts`

* **Update** **`_navigationBearings`**: Extend the state to include `activeEntryIdx` (current file index) in addition to `changeCount`, `activeIdx`, and `entriesCount`.

* **Update** **`show`** **method**: Calculate `activeEntryIdx` based on the passed `entryIndex` observable and update `_navigationBearings`.

* **Update UI**: Modify the `ActionViewItem` render logic to display the file count information (e.g., "File {0} of {1}") next to the change count.

### 2. Extension: AI Diff Sample

**File**: `ai-diff-extension-sample/src/extension.ts`

* **Session Management**:

  * Maintain a list of all active `vscode.chat.ChatEditingSession`s.

  * Initialize from `vscode.chat.editingSessions` on startup (restore).

  * Listen to `vscode.chat.onDidChangeEditingSessions` to add/remove sessions dynamically.

* **Tree Data Provider (`AiDiffTreeDataProvider`)**:

  * **Hierarchical Structure**: Change the tree view to show `Session` nodes at the top level, and `File` nodes as children of each session.

  * **Filtering**: In `getChildren`, filter out `ChatEditingFile` entries that have a state of `Accepted` or `Rejected` (keep only `Modified`).

* **Commands**:

  * Ensure commands like `accept`, `reject`, `simulateEdit` work with the new structure (targeting the appropriate session).

### 3. Verification

* **Overlay**: Verify that the editor overlay shows "1 of N changes | File 1 of M" when navigating changes.

* **Extension**:

  * Reload window -> Verify sessions are restored.

  * Create new session -> Verify new session appears in Tree View.

  * Simulate edits -> Verify files appear under the correct session.

  * Accept/Reject file -> Verify the file disappears from the Tree View.

