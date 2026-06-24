
## 5. 代码修改详细记录
以下是本次监视器优化过程中修改的所有核心文件及其变更记录摘要：

### 5.1 文件变更全局单例监听优化 (FileService)
- **`src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingModifiedFileEntry.ts`**
  - 移除了构造函数中对 `_fileService.onDidFilesChange` 的独立事件订阅。
  - 新增了 `public markAsDeleted(): void` 方法，用于供外部（Manager 层）显式触发删除状态。
- **`src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingServiceImpl.ts`**
  - 在全局单例的构造函数中注册了单一的 `_fileService.onDidFilesChange` 监听器。
  - 当触发文件删除事件时，遍历所有会话和文件条目，对符合条件的 `ChatEditKind.Created` 文件条目调用 `markAsDeleted()`。

### 5.2 语言选择器内存泄漏优化 (LanguageService)
- **`src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingSession.ts`**
  - 在 `getSnapshotModel` 时，调用 `createModel` 时将 `LanguageSelection` 替换为 `null`，随后通过 `model.setLanguage(guessedLanguage)` 进行赋值。
- **`src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingModifiedDocumentEntry.ts`**
  - 在创建 Original 快照模型时，改传 `null`，然后使用 `docSnapshot.setLanguage(...)`。
  - 增加了监听器同步机制，使 Original 模型的语言类型动态跟随 `modifiedModel.onDidChangeLanguage` 变化。
- **`src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingDeletedFileEntry.ts`**
  - 清理了未使用的 `_languageService` 依赖注入和导入。
  - 在创建原始和被修改的空模型时，统一传入 `null` 并使用 `setLanguage` 进行赋值。

### 5.3 UI 纯显示特性的懒加载 (Lazy Attach)
- **`src/vs/editor/contrib/semanticTokens/browser/documentSemanticTokens.ts`**
  - 将原本普通的 `Map` 替换为生命周期绑定的 `DisposableResourceMap`。
  - 优化了 `register` 和 `deregister` 的逻辑，现在只在 `model.isAttachedToEditor() === true` 时才实例化占用资源的 `ModelSemanticColoring`。
  - 增加了对 `model.onDidChangeAttached` 事件的监听，当编辑器 Tab 打开或关闭时，动态挂载或销毁该 UI 监听器。

### 5.4 核心配置监听器的单例广播重构
- **语言配置 (`LanguageConfigurationService`)**
  - **`src/vs/editor/common/model/textModel.ts`**：移除了构造函数中内部订阅 `_languageConfigurationService.onDidChange` 的代码，改为暴露一个公有方法 `public onLanguageConfigurationChange(e)` 供外部触发更新。
  - **`src/vs/editor/common/services/modelService.ts`**：在基础 `ModelService` 中注入了 `ILanguageConfigurationService`。由 `ModelService` 注册单一全局监听，当配置发生变化时，循环遍历所有的 Models 并广播调用 `onLanguageConfigurationChange`。
  - **`src/vs/workbench/services/model/common/modelService.ts`**：同步更新了继承类的构造函数签名，正确传递新注入的语言配置服务。
- **只读配置 (`FilesConfigurationService`)**
  - **`src/vs/workbench/services/textfile/common/textFileEditorModel.ts`** & **`src/vs/workbench/services/workingCopy/common/storedFileWorkingCopy.ts`**：
    - 移除了各自类内部的 `filesConfigurationService.onDidChangeReadonly` 独立订阅。
    - 将触发逻辑封装为公共方法 `updateReadonly()`（同步补齐了 TypeScript 接口 `IStoredFileWorkingCopy` 的声明）。
  - **`src/vs/workbench/services/textfile/common/textFileEditorModelManager.ts`** & **`src/vs/workbench/services/workingCopy/common/storedFileWorkingCopyManager.ts`**：
    - 在 Manager 管理类中统一注册了单一的 `onDidChangeReadonly` 监听器。
    - 当事件触发时，遍历所有被管理的模型或副本实例，广播调用它们的 `updateReadonly()` 方法。

### 5.5 清退规避报错的 Hack 代码
撤销了之前为抑制警告而强行提高 `leakWarningThreshold` 的代码，让底层防线重新生效：
- **`src/vs/editor/common/languageFeatureRegistry.ts`**：移除了 1000 阈值。
- **`src/vs/editor/common/languages/languageConfigurationRegistry.ts`**：移除了 1000 阈值。
- **`src/vs/workbench/services/themes/browser/workbenchThemeService.ts`**：从 1000 还原至原始的 400。
- **`src/vs/workbench/services/filesConfiguration/common/filesConfigurationService.ts`**：移除了 1000 阈值。