# VS Code MCP（社区 test/mcp）能力评估

> 对象：本仓库（Code OSS 1.113.0）的 `test/mcp`，以及它依赖的 `test/automation`。
> 背景：内部使用的 VS Code MCP（zyh/ai-research）基于 `test/mcp`，负责人在此基础上增加了自动录屏和一些操作。这些改动本文没有看到，内部行为以内部代码为准。
> 用途：为验证、性能角色和 MCP 需求单提供依据。[04](04-agent-prompt-kit.md) v2.1 已按本文更新。

## 结论

做功能和界面验证够用：能启动实例、截图、读取页面结构、执行脚本、读取控制台、模拟键盘和鼠标。但有四个问题会直接影响这个项目：

1. **不适合直接测性能。** 启动的实例处于开发模式，关闭了 V8 代码缓存，还开启了带截图的 tracing。这样测出的启动和加载数据不代表用户使用的构建。
2. **多个 agent 同时使用会互相干扰。** 一个 MCP 进程只管一个 VS Code 实例；默认不隔离用户数据目录；每次启动都会清空日志目录。
3. **进不了 webview。** 选择器和脚本只作用于主文档。旧插件的界面在 webview 的 iframe 里，只能截图和按坐标操作，新旧方案没法用同一套检查对比。
4. **缺少本项目需要的工具。** 没有 CodeMate 专用操作，也没有读取性能打点、固定窗口尺寸、按元素截图的工具。

第三节按优先级列出了建议的增强。

## 一、现有能力

| 类别 | 内容 |
| --- | --- |
| 生命周期 | `vscode_automation_start`（参数 `recordVideo`、`workspacePath`）、`vscode_automation_restart`（`workspaceOrFolder`、`extraArgs`）、`vscode_automation_stop`。启动前其他工具都处于禁用状态（`test/mcp/src/automation.ts:39`）；停止时保存 Playwright trace。 |
| 窗口通用操作 | `vscode_automation_window_*`：窗口列表与切换、整窗截图、无障碍树快照、按 CSS 选择器点击 / 输入 / 悬停 / 拖动 / 定位、按坐标操作鼠标、按键、等待元素或文本、执行 JavaScript（`window_evaluate`）、读取控制台消息（`window_console_messages`）。 |
| 工作台功能 | 编辑器、终端、调试、搜索、扩展、命令面板、资源管理器、活动栏、源代码管理、状态栏、问题、设置、快捷键、notebook、本地化、任务、Chat。Chat 工具操作的是社区内置 Chat，不是 CodeMate；profiler 工具是空的。 |
| 启动参数 | 在 `.vscode/mcp.json` 的 `args` 中设置（`test/mcp/src/options.ts`）：`--build`、`--stable-build`、`--web`、`--headless`、`--browser`、`--remote`、`--video`、`--autostart`、`--verbose`、`--electronArgs`、`--extensionDevelopmentPath`。 |
| 产物 | 日志和 trace 在 `.build/vscode-playwright-mcp/logs`，录屏在 `.build/vscode-playwright-mcp/videos`（1920×1080）。 |

版本差异：2026 年 2 月以前，`test/mcp` 名为 `vscode-playwright-mcp`，通过 `@playwright/mcp` 提供 `browser_*` 工具；之后去掉了这个依赖，改为同等的 `vscode_automation_window_*` 工具，并支持多窗口。如果 vscode-internal 或内部 MCP 基于更早的版本，工具名不同，能力大体相同。

## 二、对本项目的影响

### 1. 性能测量

- V8 代码缓存被关闭了两次：启动参数固定带 `--no-cached-data`（`test/automation/src/electron.ts:30`，2022 年起就有）；`VSCODE_DEV` 也会关闭代码缓存（`src/main.ts` 的 `getCodeCachePath`）。用户实际使用时，从第二次启动起会用到代码缓存。
- 即使传了 `--build`，`getApplication` 也会设置 `VSCODE_DEV=1`（`test/mcp/src/application.ts:236`）。`isBuilt` 只看这个变量（`src/vs/platform/environment/common/environmentService.ts:208`），所以窗口加载的是 `workbench-dev.html`（`src/vs/platform/windows/electron-main/windowImpl.ts:1215`），语言包也不加载（`src/bootstrap-esm.ts:71`），界面语言可能和用户环境不同。不传 `--build` 时直接从源码运行，模块不打包，加载方式和生产构建完全不同。
- Playwright tracing 总是开启并截图（`test/automation/src/playwrightElectron.ts:54`，`test/mcp/src/application.ts:254`）；录屏开启时还要编码视频。两者都占用 CPU。
- 每次工具调用都有 MCP 和 Playwright 的往返开销。用「点击后等待元素出现」这类方式计时，误差无法控制。

建议：

- 启动和加载性能用生产构建、固定参数测量，例如 `npm run perf -- --build <路径>`（默认启用代码缓存），不经过 MCP 启动。
- 运行期指标（打开面板、首字、流式渲染）在页面内打点，再用 `window_evaluate` 读取 `performance.getEntriesByType('mark')`。读数时把 tracing 和录屏的状态写进性能记录，所有对照对象保持相同条件。
- MCP 主要用于功能、界面和集成验证。

### 2. 多实例与并发

- 一个 MCP 进程只管理一个 VS Code 实例（可以有多个窗口）。
- 默认不传 `--user-data-dir`（`test/mcp/src/application.ts:241` 起的启动选项），使用开发版默认的用户数据目录。状态会在多次运行之间保留，也和手动启动的开发实例共用。两个实例共用同一目录时，后启动的会被 VS Code 的单实例机制交给已运行的实例，可能启动失败，或者在另一个实例里多开一个窗口。启动和等待首个窗口都没有超时（`test/automation/src/playwrightElectron.ts:42`、`:47`），窗口不出现时会一直等待。
- 日志目录在每次 MCP 进程启动时清空（`test/mcp/src/application.ts:30`）。同一个仓库目录下运行多个 MCP 进程，会互相删掉日志。

建议：

- 每个 agent 使用独立的 MCP 进程和 worktree，并通过 `--electronArgs` 或 `restart` 的 `extraArgs` 传入独立的 `--user-data-dir`、`--extensions-dir`，在任务卡上登记。
- 需要干净状态的场景，每次换新目录；验证状态恢复的场景，在同一目录内重启。

### 3. 旧插件与新实现的对比

- 选择器类工具和 `window_evaluate` 只作用于当前窗口的主文档（`test/automation/src/playwrightDriver.ts:192`）。Playwright 的 CSS 选择器能穿透开放（open）模式的 Shadow DOM，但进不了 iframe；`window_evaluate` 里的 `document.querySelector` 两者都穿不透，要经过宿主元素的 `shadowRoot`。
- webview 是两层 iframe：外层由 `src/vs/workbench/contrib/webview/browser/webviewElement.ts:402` 创建，内容在 `pre/index.html` 创建的内层 iframe 中（`:1041`）。旧插件的界面只能截图、录屏，以及用坐标和键盘操作，读不到 DOM 和打点。
- 新实现如果使用封闭（closed）模式的 Shadow DOM，选择器也进不去。

建议：给 MCP 增加按 frame 执行脚本和定位元素的能力（MCP-003）。在此之前，旧插件的基线以截图、录屏和插件自身的日志、打点为主，对比报告中写明双方各用了什么手段。

### 4. 其他

- 传 `--build` 时，会先从 `update.code.visualstudio.com` 下载上一个稳定版（`test/mcp/src/application.ts:221`、`:146`，用于迁移测试）。内网访问不到时，传 `--stable-build` 指向本地已有的构建。
- `--remote` 通过 vscode-test-resolver 模拟远程工作区，可以用来检查文件和终端操作是否在远端执行。
- `window_console_messages` 可以用来检查 CSP、Trusted Types 违规和运行时报错，适合放在每个场景的最后。

## 三、建议的 MCP 增强

| 编号 | 能力 | 用途 | 优先级 |
| --- | --- | --- | --- |
| MCP-001 | 实例隔离：每次启动可指定用户数据目录、扩展目录和日志目录；同一台机器上多个 MCP 进程可以同时运行；启动设超时 | 多 agent 并行；测试可重复 | 阻塞 |
| MCP-002 | 生产形态启动：使用打包产物且不设置 `VSCODE_DEV`；可关闭 `--no-cached-data`、tracing 和录屏；返回实际使用的启动参数 | 在接近用户环境的条件下测运行期指标 | 阻塞（性能） |
| MCP-003 | 按 frame 操作：列出 frame（包括 webview），在指定 frame 中执行脚本、定位元素 | 旧插件基线；新旧对比 | 阻塞（对比） |
| MCP-004 | 读取性能打点：返回主文档和指定 frame 的 performance mark，附 `performance.timeOrigin`，便于换算到同一时间轴 | 运行期指标 | 重要 |
| MCP-005 | 固定截图条件：窗口或视口尺寸、缩放、主题、语言；按元素截图 | 成对截图比对 | 重要 |
| MCP-006 | 页面内计时：在页面内等待选择器或文本出现，返回页面内测得的耗时 | 排除工具往返误差；各 agent 测法一致 | 改善（现有 `window_evaluate` 可以执行返回 Promise 的脚本，能临时替代） |
| MCP-007 | CodeMate 高层操作：打开面板、发送消息、等待流式结束、取消、读取最后一条回复 | 端到端场景可重复，少拼选择器 | 改善 |
| MCP-008 | 录屏控制：按场景开始和结束、按场景命名文件、与 trace 对应；结果中注明录屏是否开启 | 留存证据；避免干扰性能数据 | 改善（已部分实现） |

## 四、需要确认的内部改动

这些问题已放进 [05](05-info-request-prompt.md) 的 G 节：

- 内部 MCP 基于哪个时间点的 `test/mcp`，放在哪里，如何指向 vscode-internal 的源码或构建产物。
- 自动录屏如何工作，新增了哪些操作。
- 是否改过启动参数和环境、用户数据目录和日志目录的处理、多实例支持、对 webview iframe 的访问。
- 第三节的需求中，哪些已经实现。
