# 迁移路线评审：Vue 直挂 Workbench DOM + useService 直连 DI

> 评审对象：同事的前期方案——把插件从「iframe + postMessage 的扩展形态」重构为「Vue 直接挂载到 Workbench DOM，通过 `useService` 直连 IDE DI 服务的原生内置形态」。
> 路线：先迁移后优化 → 导入插件源码 → 搭建 Bridge 层 → 批量迁移前端 → 加载内核 SDK → 逐个接线 handler → 清理死 handler → 最终修复。
> 说明：评审基于方案描述与 VS Code 源码约束，尚未看到具体实现代码。

## 结论

**方向是对的**，与 [02-vue-plugin-ui-in-workbench.md](02-vue-plugin-ui-in-workbench.md) 推荐的方案 B 一致：保留 Vue 界面，去掉 iframe 和 postMessage，直接调用基座服务。这是在「界面不变」前提下唯一能接近社区性能的路线。

但「先迁移后优化」不能覆盖所有事项。下面几项是**架构决策**，越晚改代价越大，必须在搭建 Bridge 层时就定下来，不能留到「最终修复」：

1. 内核 SDK 运行在哪个进程；
2. 远程开发（SSH / WSL / 容器）场景下的执行位置；
3. 挂载点的隔离方式（Shadow DOM、Trusted Types、弹层）；
4. 模型输出渲染的安全边界；
5. 迁移前的性能基线。

## 一、必须前置的架构决策

### 1. 内核 SDK 的运行进程（最关键）

- 渲染进程开启了沙箱：本仓库 `src/vs/platform/windows/electron-main/windows.ts:156` 为 `sandbox: true`，不能 `require` Node 模块。SDK 如果依赖 `fs`、`child_process`、`net`、代理 agent 等，**在渲染进程里根本加载不了**。
- 即使 SDK 是纯 JS、能在渲染进程运行，agent 循环、大 JSON 解析、token 计数、上下文拼装也会和界面抢主线程，流式输出时会卡顿。社区正是因此把 agent 放进了独立 utility 进程（`src/vs/platform/agentHost`，本仓库已有约 9.5k 行的早期版本）。
- **建议**：SDK 放在 utility 进程，渲染进程通过 MessagePort 直连（参照 `AgentHostProcessManager` 懒启动 + `acquirePort`）。Vue 和 Bridge 只做界面与轻量编排。在「加载内核 SDK」之前先确认 SDK 的依赖清单。

### 2. 远程开发场景

- 原插件运行在扩展宿主；远程工作区下，扩展宿主运行在**远程机器**上，读写文件、执行终端命令天然发生在远端。
- 迁到渲染进程后，这个默认行为消失了：
  - 文件读写必须走 `IFileService`（它会自动路由到远端），不能直接用 Node 的 `fs`；
  - 终端走 `ITerminalService`；
  - SDK 若需要访问工作区文件或执行命令，要在远端有对应的进程（社区为此做了 SSH / WSL 远程 agent host）。
- 如果团队有远程开发用户，需要在 Bridge 设计阶段就明确每个 handler 在本地还是远端执行。

### 3. 挂载点隔离

「直接挂载到 Workbench DOM」需要同时解决以下问题，挂载点一旦定型，后面改动会波及所有组件：

- **样式**：Element Plus / DevUI 的全局样式会影响 VS Code 自身界面，建议使用 Shadow DOM。
- **弹层**：组件库弹层默认挂到 `body`，放进 Shadow DOM 后需要统一改挂载容器。
- **Trusted Types**：`workbench.html` 设置了 `require-trusted-types-for 'script'`，Vue 3.4+ 需要白名单中有 `vue` 策略，`v-html` 需要 `TrustedHTML`。
- **主题**：`--vscode-*` 变量作用域是 `.monaco-workbench`，可以穿透 Shadow DOM，原有主题映射可保留。

### 4. 安全边界

- 原来 Vue 运行在 iframe 沙箱里，即使模型输出中混入恶意 HTML，也只能影响 iframe 内部。
- 迁入 Workbench DOM 后，Vue 与所有 DI 服务同处一个上下文，`useService` 能拿到命令、文件、终端等服务。**模型输出经 `v-html` 渲染若未清洗，就是可以执行任意 IDE 操作的 XSS。**
- **建议**：DOMPurify + Trusted Types 必须在第一个渲染模型输出的组件上线时就到位，不能放到最终修复阶段。

### 5. 迁移前的性能基线

- 目标是「性能与社区一致」，验收需要数据。如果迁移前不测插件版，迁移后就无法证明提升，也无法定位退化。
- **建议**：在动手前给插件版埋点，并在新形态里从第一天就埋同名打点（参照社区 `chatPerf.ts`；本仓库 1.113 中没有该文件，需要移植）：
  - 打开面板 → 首次渲染完成；
  - 按下发送 → 请求显示（`request/start` → `request/uiUpdated`）；
  - 按下发送 → 首个 token（`request/firstToken`）；
  - 长回复流式期间的帧率或长任务数量。

## 二、对各步骤的具体建议

| 步骤 | 评价 | 建议 |
| --- | --- | --- |
| 先迁移后优化 | 对界面层合理 | 第一节的五项架构决策不适用这一原则，必须前置 |
| 导入插件源码 | 合理 | `.vue` 文件无法由 VS Code 的 tsc / gulp 编译，需要独立的 Vite 构建并接入 gulp；在 `build/filters.ts` 中排除出 hygiene 与 eslint；补充第三方许可证。代码放在独立 contrib 目录，减少与社区合并时的冲突（本仓库 1.113，社区已到 1.143） |
| 搭建 Bridge 层 | 关键步骤 | 消息协议定义成带类型的接口（方法名、参数、返回值、事件）；Bridge 内对未识别的消息打日志，为后面清理死 handler 提供依据；尽量保留 webview 版实现，过渡期同一份 Vue 源码产出两个版本便于比对 |
| 批量迁移前端 | 合理 | `useService` 只在 composables / Bridge 层使用，不要散落到业务组件里，否则 Vue 代码与 VS Code 内部 API 深度耦合，插件版无法并行，升级社区版本时改动面大 |
| 加载内核 SDK | 风险最高 | 先确认 SDK 依赖与运行进程（见第一节第 1 条）；不要默认放在渲染进程 |
| 逐个接线 handler | 合理 | 先建一张「消息类型 → handler → 状态（已接线 / 已替代 / 死）→ 测试」的清单矩阵，按矩阵推进；每接一个 handler 补一个自动化用例 |
| 清理死 handler | 合理 | 以证据为准：静态搜索调用点 + Bridge 未识别消息日志 + 一段时间的运行数据，不要靠推测 |
| 最终修复 | 合理 | 用界面截图比对和性能打点对比作为验收标准，而不是开放式的「修 bug」阶段 |

## 三、useService 直连 DI 的注意事项

- **生命周期**：VS Code 的 `Event` 订阅返回 `IDisposable`，必须在 `onUnmounted` 中释放，否则面板反复开关会泄漏。建议封装 `useEvent(service.onDidXxx, handler)` 这类 composable，统一自动释放。
- **不要让 Vue 代理服务对象**：服务实例放进 `ref` / `reactive` 会被 Vue 深度代理，既有性能开销，也可能破坏内部状态。服务引用直接保存或用 `markRaw`；需要响应式的只是从服务里取出的数据。
- **observable 与 Vue 响应式的桥接**：社区大量使用 `vs/base/common/observable`，可以写一个 `useObservable(obs)`，在 `autorun` 中把值写进 `shallowRef`，在卸载时 dispose。
- **服务初始化时机**：社区服务大多是 `InstantiationType.Delayed`，第一次 `get` 时才构造。在 `setup` 中一次性获取大量服务会把构造成本集中到面板首次打开，应按需获取。
- **多窗口**：每个窗口有独立的渲染进程和 DI 容器，与 webview 版一致；但 utility 进程中的 SDK 若为单例，要处理多窗口共享与隔离。

## 四、调整后的建议顺序

0. **基线与盘点**：给插件版埋性能打点；盘点全部 postMessage 消息类型；梳理内核 SDK 的依赖与运行要求。
1. **导入插件源码**：独立 Vite 构建接入 gulp，排除规则与许可证。
2. **搭建 Bridge 层并确定架构**：挂载点（Shadow DOM、Trusted Types、弹层、主题、i18n）、SDK 运行进程、远程执行位置、带类型的消息协议、未识别消息日志、DOMPurify。
3. **批量迁移前端**：`useService` 收敛在 composables 中。
4. **加载内核 SDK**：放在第 2 步确定的进程中，MessagePort 直连。
5. **按矩阵逐个接线 handler**：每个 handler 配自动化用例与性能打点。
6. **按证据清理死 handler**。
7. **一致性与性能验收**：截图比对 + 与插件版、社区同版本的打点对比；处理停用旧扩展，避免命令、视图、快捷键 ID 重复注册。
8. **性能优化**：流式合批、响应式降级（`shallowRef` / `markRaw`）、懒加载、虚拟滚动、增量 markdown 渲染。

## 五、需要同事补充的信息

- 内核 SDK 的依赖（是否依赖 Node 内置模块、是否有原生模块）、计算负载，以及当前计划在哪个进程加载；
- 是否需要支持远程开发（SSH / WSL / 容器）；
- 当前挂载方式是否使用 Shadow DOM，以及 Trusted Types 是如何处理的；
- `useService` 目前在哪些层被调用；
- 插件版现有的性能数据（如果有）。
