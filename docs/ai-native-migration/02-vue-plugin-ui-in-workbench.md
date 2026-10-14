# Vue 插件界面迁入基座方案（保持界面一致）

> 前提：迁移后界面、布局、功能必须与插件版一致。插件前端使用 Vue 3 + DevUI + Element Plus + vue-i18n + AIhelper。
> 技术约束已在社区 `main` @ `0ea598a48bf` 与本仓库 1.113.0 中核实。

## 结论

不要改用社区的 `ChatWidget`，那等于重写一套界面。推荐做法：

1. 把现有 Vue 应用**原样挂载到基座的 ViewPane**，不再使用 webview；
2. 只替换通信层；
3. AI 逻辑下沉到基座服务或独立进程。

Vue 组件代码基本不用动。性能收益来自三处：去掉 webview 的 iframe 和独立文档；去掉 webview → 渲染进程 → 扩展宿主的两次 `postMessage` 序列化；不再等待扩展激活。

## 一、方案对比

| 方案 | 界面一致性 | 性能 | 工作量 | 主要风险 |
| --- | --- | --- | --- | --- |
| A. 基座里继续用 webview 承载 Vue | 完全一致 | 只省掉扩展激活和扩展宿主一跳 | 小 | 达不到社区水平 |
| **B. Vue 直接挂载到基座 DOM（Shadow DOM 隔离）——推荐** | 几乎完全一致 | 同一渲染上下文，函数直接调用，无序列化 | 中 | Trusted Types、全局样式、弹层、快捷键 |
| C. 用 VS Code 原生 DOM 重写（社区做法） | 很难完全一致 | 最好 | 大 | 无法复用 DevUI / Element Plus / AIhelper |

## 二、推荐方案的分层

```text
Vue 应用（原插件前端：DevUI + Element Plus + AIhelper + vue-i18n）
  - 组件、布局、样式、文案不变
  - 只替换通信层模块
  - 用 Vite 单独打包为 ESM，不进入 workbench.desktop.main.js
        │  首次可见时动态 import()，挂载到 Shadow Root
        ▼
基座 ViewPane（独立 contrib，例如 contrib/aiAssistant/browser）
  - ViewContainer + SyncDescriptor 声明式注册，位置与插件版相同
  - renderBody 先画静态骨架，再懒加载 Vue 包；隐藏时不卸载
  - 桥接对象：postMessage → 直接调用服务；getState/setState → IStorageService
        │  直接方法调用 / 事件，无序列化
        ▼
AI 能力服务层
  - 轻逻辑（会话、配置、编排）：渲染进程中的 Delayed 单例
  - 重逻辑（agent 循环、工具执行、索引、长连接）：utility 进程 + MessagePort（参照 Agent Host）
  - 可复用不影响界面的社区服务：语言模型、工具、MCP、终端、文件、搜索
```

## 三、必须处理的技术约束

| 约束 | 依据 | 影响 | 处理方式 |
| --- | --- | --- | --- |
| **Trusted Types 强制开启** | `src/vs/code/electron-browser/workbench/workbench.html`：`require-trusted-types-for 'script'`，`trusted-types` 白名单只有 `dompurify`、`tokenizeToString` 等策略 | Vue 3.4+ 插入静态内容时会创建名为 `vue` 的策略；`v-html`、markdown 渲染、组件库内部的 `innerHTML` 字符串赋值都会被拦截 | 白名单加入 `vue` 及 AIhelper 需要的策略；markdown 统一经 DOMPurify 输出 `TrustedHTML` 再交给 `v-html`；同步修改 `workbench-dev.html` 与 web 版 html；开发期观察 CSP 违规逐个修复 |
| **全局样式污染** | 工作台共用一个 `document` | 组件库基础样式、`:root` 变量、全局选择器会影响 VS Code 界面 | Shadow DOM 隔离，组件库 CSS 只注入 shadow root |
| **弹层挂到 body** | Shadow DOM 外的节点拿不到内部样式 | `el-popper`、`ElMessage`、`ElDialog`、DevUI overlay 丢样式或层级错乱 | 弹层统一挂到 shadow root 内的容器（Element Plus 的 `teleported` / `append-to` / `appendTo`，DevUI 对应的 overlay 配置）；核对与 VS Code 菜单、悬浮提示的 z-index |
| **主题变量** | `colorThemeCss.ts` 把颜色输出为 `--vscode-*`，作用域 `.monaco-workbench`（`workbenchThemeService.ts:597`） | CSS 变量可穿透 Shadow DOM，且与 webview 注入的变量同名 | 现有 `--vscode-*` → 组件库主题变量的映射代码原样保留 |
| **快捷键与焦点** | 快捷键在 window 级别分发；webview 中由 iframe 先处理再转发 | Enter、Esc、Ctrl+Enter、撤销等行为可能变化 | 获得焦点时设置 context key，相关快捷键加 `when` 条件；逐个回归 |
| **国际化** | `vs/base/common/platform.ts` 的 `language` 与 `vscode.env.language` 同源 | vue-i18n 可原样保留 | 从 `platform.language` 读取语言；用 `@intlify/unplugin-vue-i18n` 预编译文案 |
| **eval 与模板编译** | `script-src 'self' 'unsafe-eval' blob:` | 运行时编译不会被拦截，但拖慢首屏 | 使用预编译模板的 runtime-only 构建 |
| **字体与网络** | `font-src` 仅 `'self'` 与指定域名；`connect-src` 允许 `https:`、`ws:` | CDN 字体/图标会失败 | 字体图标打进产物；模型请求建议走 `IRequestService`，与原插件代理和证书行为一致（需实测） |
| **渲染进程沙箱** | `src/vs/platform/windows/electron-main/windows.ts`（本仓库第 156 行）`sandbox: true` | 渲染进程不能 `require` Node 模块 | 依赖 `fs`、`child_process`、`net` 的逻辑必须放在 utility 进程、共享进程或扩展宿主 |

## 四、构建与加载

- **构建**：单独的 Vite 工程，lib 模式输出 ESM 与 CSS；`vue` 在 DevUI、Element Plus、AIhelper 之间去重；组件按需引入（`unplugin-vue-components`），去掉未使用的语言包。
- **放置**：作为内部 npm 包放进根 `package.json` 的 `dependencies`；或放在 contrib 目录下，并在 `build/filters.ts` 中排除出 TypeScript 编译、eslint 与 hygiene 检查。补充 `ThirdPartyNotices.txt` 与 `cglicenses.json`。
- **加载**：参照 `src/vs/amdX.ts` 的 `resolveAmdNodeModulePath`，用 `FileAccess.asBrowserUri` 得到 `vscode-file://` 地址，在 `renderBody` 中动态 `import()`。Vue 包不在启动关键路径上。
- **代码缓存**：`vscode-file` 协议开启了 `codeCache`（社区 `src/main.ts:117`），窗口启用了 `v8CacheOptions: 'bypassHeatCheck'`（`windowImpl.ts:781`），第二次启动起可复用 V8 代码缓存。

## 五、通信层改造

把插件前端中所有 `acquireVsCodeApi()`、`postMessage`、`window.addEventListener('message')` 收敛到一个 transport 模块，提供 webview 和基座两套实现。过渡期用同一份 Vue 源码同时产出两个版本，方便逐项比对界面。

| 插件版（webview） | 基座版 | 说明 |
| --- | --- | --- |
| `vscode.postMessage(msg)` | `bridge.invoke(method, args)` | 直接调用，返回 Promise，无 JSON 序列化 |
| `window.addEventListener('message')` | `bridge.onEvent(listener)` | 不能复用 window 的 message 事件，工作台其他模块也在监听 |
| `vscode.getState()` / `setState()` | `bridge.getState()` / `setState()` | 落到 `IStorageService`（工作区范围） |
| 扩展侧 `webview.onDidReceiveMessage` | 基座服务方法 | 原消息处理逻辑迁成 TypeScript 服务 |
| 逐 token `postMessage` | 服务端合批，按 `requestAnimationFrame` 推送 | 对应社区的微任务合批与 30ms 节流 |

## 六、Vue 侧性能措施

**加载**
- 首次可见才 `import` Vue 包；先显示与插件版相同的静态骨架。
- 面板隐藏时不卸载。
- AIhelper 中的代码高亮、markdown 解析等重模块二次懒加载。

**流式渲染**
- 消息列表用 `shallowRef` + `triggerRef`，大对象 `markRaw`，避免深层响应式追踪每个 token。
- token 先进缓冲区，每帧刷新一次；markdown 只追加渲染新增部分（参照社区 `chatIncrementalRendering`）。
- 长对话虚拟滚动；代码块在该块流式结束后再高亮。

## 七、待确认事项

- AIhelper 是否大量使用 `v-html`、是否依赖 webview 特有 API、是否自带 markdown 与高亮库，决定了 Trusted Types 改造的工作量，是最大风险项。
- Element Plus 与 DevUI 内部的 `innerHTML` 用法需要在原型中实测。
