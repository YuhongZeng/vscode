# 生产环境 Electron 渲染进程 OOM 自动化无感知诊断方案报告

## 1. 背景与挑战 (Background & Challenges)

在基于 Electron 的桌面应用（如 VS Code）中，内存泄漏和 OOM（Out Of Memory）一直是最难定位的问题之一，特别是发生在 **渲染进程 (Renderer Process)** 时。
渲染进程直接面向用户，负责复杂的 DOM 渲染、编辑器核心逻辑和各种富文本交互。当它发生 OOM 时，用户通常只会看到一个突发的“白屏”或“进程崩溃”提示，而由于以下原因，我们很难在生产环境排查出具体是哪里泄漏了：

1. **沙盒 (Sandbox) 限制**：现代 Electron 应用出于安全考虑，默认对渲染进程启用了 Sandbox 并且强制使用 ESM 加载机制。这意味着渲染进程无法访问 Node.js 的原生模块（如 `fs`, `v8`）和 C++ 插件。
2. **生产环境的性能敏感性**：开发者通常可以使用 Chrome DevTools 手动录制全量的 `.heapsnapshot`，但在生产环境中自动触发全量转储是灾难性的。一个典型的 VS Code 渲染进程在 OOM 时，内存占用常常超过 1.5GB，全量转储会使进程完全卡死数分钟，并且产生巨大的文件，既可能导致转储本身 OOM，也无法通过网络上传给分析系统。
3. **环境复杂不可复现**：用户的电脑环境、操作习惯、打开的工作区各不相同，很多 OOM 问题在开发者的本地机器上极难复现，必须依赖从用户真实崩溃现场捕获的数据。

## 2. 现有思路对比与痛点分析

为了解决上述问题，我们考察了以下几种技术路径：

### 方案一：全量 Heap Snapshot (堆快照) 转储
- **思路**：监听内存阈值，一旦达到（比如 1.5GB），调用 `v8.writeHeapSnapshot()` 或通过 CDP 调用 `HeapProfiler.takeHeapSnapshot`。
- **痛点**：
  - 致命的性能开销：导出过程极其缓慢（可能需要 1~3 分钟），在此期间 UI 完全冻结，严重破坏用户体验。
  - 文件体积过大：动辄上 GB 的文件，几乎不可能静默上传。
  - 不稳定性：在内存临界点执行全量转储，极大概率会直接引发 V8 的 Fatal Error (OOM)，导致转储失败。

### 方案二：使用 Node.js 的 `v8.getHeapStatistics` 和 `pprof`
- **思路**：这是 VS Code Extension Host (扩展宿主进程) 正在使用的成熟方案。通过 Google 的 `pprof` C++ 扩展，在后台进行极低开销的内存分配采样。
- **痛点**：
  - **沙盒隔离冲突**：渲染进程开启了沙盒，无法 `require` Node.js 的模块。如果为了诊断强行在预加载脚本中暴露 `fs` 或关闭沙盒，会带来极大的安全风险。
  - **ESM 解析错误**：强制注入 Node 依赖常常会导致类似 `Failed to resolve module specifier 'fs'` 的致命启动错误。

### 方案三：使用 Chrome CDP (Chrome DevTools Protocol) 的 HeapProfiler Sampling
- **思路**：通过 Electron 的 `webContents.debugger` 从主进程向渲染进程发送 CDP 指令：`HeapProfiler.startSampling`。这利用了 V8 内置的 Allocation Profiler，它只在内存分配时按间隔（如 512KB）记录调用栈，不记录具体的数据内容。
- **优势**：
  - **性能开销极低**：CPU 开销 < 1%，对用户完全透明，可以在后台持续运行。
  - **沙盒安全**：由主进程发起，不破坏渲染进程的任何安全边界。
  - **产物极小**：生成的 `.json` Profile 文件通常只有几十到几百 KB，易于本地保存或上报。
  - **直观可见**：产出物可以直接在 Chrome DevTools 或 Speedscope 中作为“火焰图”查看，直接定位到泄漏的 JS 函数。

**最终决策**：我们选择 **方案三（CDP HeapProfiler Sampling）**，并结合纯内存的 **Breadcrumbs（业务轨迹日志）** 上报机制，作为最终的生产环境解决方案。

---

## 3. 详细实现方案与代码解析

本方案采用“双通道”策略：主进程负责“高权限的诊断操作（CDP & 文件 I/O）”，渲染进程负责“轻量级的轮询与阈值判定”，两者通过 IPC 通信。

### 3.1 移除危险的 Node 注入
首先，我们在 `desktop.main.ts` 中移除了原来试图强行将 Node 版 `oomDiagnostics.js` 注入到渲染进程的逻辑。这彻底解决了沙盒报错问题，使得 Renderer 启动更加安全。

### 3.2 实现主进程的 CDP 采样引擎 (heapSamplingProfiler.ts)
我们在主进程中封装了一个 `HeapSamplingProfiler` 类，核心利用了 `webContents.debugger`：

```typescript
// src/vs/platform/profiling/electron-main/heapSamplingProfiler.ts
export class HeapSamplingProfiler {
    async start(): Promise<void> {
        const inspector = this._window.webContents.debugger;
        if (!inspector.isAttached()) {
            inspector.attach();
        }
        await inspector.sendCommand('HeapProfiler.enable');
        // 核心：以 512KB 为间隔开启后台分配采样，开销极低
        await inspector.sendCommand('HeapProfiler.startSampling', { samplingInterval: 512 * 1024 });
    }

    async dumpProfile(reason: string): Promise<string> {
        // 获取采样数据并由主进程落盘
        const { profile } = await inspector.sendCommand('HeapProfiler.getSamplingProfile');
        const profilePath = join(tmpdir(), 'vscode-oom-diagnostics', `Renderer-${reason}-sampling.json`);
        await fs.writeFile(profilePath, JSON.stringify(profile));
        return profilePath;
    }
}
```

并在 `nativeHostMainService.ts` 暴露了两个 IPC 接口供渲染进程调用：`startRendererHeapSampling` 和 `dumpRendererHeapSamplingProfile`。

### 3.3 业务轨迹 Breadcrumbs 的纯内存化与 IPC 持久化
单纯的内存快照只能告诉你“哪个函数分配了内存”，但无法告诉你“用户当时在做什么操作”。因此我们需要 Breadcrumbs。
在渲染进程中，`OOMDiagnosticMonitor` 只在内存中维护一个环形队列（不写磁盘）。
在 `nativeHostMainService.ts` 中，我们新增了 `saveRendererBreadcrumbs` IPC 方法：

```typescript
// 主进程收到渲染进程的 breadcrumbs 数组后，将其写入磁盘
async saveRendererBreadcrumbs(windowId: number | undefined, reason?: string, breadcrumbs?: any[]): Promise<void> {
    if (!breadcrumbs || breadcrumbs.length === 0) return;
    const breadcrumbsPath = join(dumpDir, `Renderer-${reason}-breadcrumbs.json`);
    await fs.writeFile(breadcrumbsPath, JSON.stringify(breadcrumbs, null, 2));
}
```

### 3.4 渲染进程的智能按需轮询 (desktop.main.ts)
在渲染进程的入口，我们通过 `vscode.process.getProcessMemoryInfo()` 启动了一个极其轻量的轮询。

```typescript
private startRendererOOMPolling(mainProcessService: IMainProcessService, windowId: number, configurationService: IConfigurationService, logService: ILogService) {
    const isOOMDiagnosticsEnabled = () => configurationService.getValue<boolean>('developer.enableOOMDiagnostics') === true;
    let checkInterval = 5000;
    const thresholdMB = 1500; // OOM 危险阈值 1.5GB

    const checkMemory = async () => {
        if (!isOOMDiagnosticsEnabled()) return setTimeout(checkMemory, checkInterval);

        const info = await vscodeProcess.getProcessMemoryInfo();
        const currentMB = Math.round(info.private / 1024);

        // 动态频率：平时 5秒一次，接近阈值时 1秒一次，将开销降到最低
        checkInterval = currentMB > thresholdMB * 0.8 ? 1000 : 5000;

        if (currentMB > thresholdMB) {
            // 达到阈值，触发 IPC，让主进程去 Dump！
            await mainProcessService.getChannel('nativeHost').call('dumpRendererHeapSamplingProfile', [windowId, 'RendererOOM']);
            await mainProcessService.getChannel('nativeHost').call('saveRendererBreadcrumbs', [windowId, 'RendererOOM', monitor.getBreadcrumbsSnapshot()]);
        }
        setTimeout(checkMemory, checkInterval);
    };

    // 如果配置开启，通知主进程开始采样
    if (isOOMDiagnosticsEnabled()) {
        mainProcessService.getChannel('nativeHost').call('startRendererHeapSampling', [windowId]);
    }
    setTimeout(checkMemory, checkInterval);
}
```
**注意**：这里的 IPC 通信通过显式传入当前窗口的 `windowId`，确保了主进程能够精确地将 debugger 挂载到发生 OOM 的那个具体的 Renderer 窗口上。

### 3.5 生产环境的安全开关 (desktop.contribution.ts)
提供了一个全局设置项 `developer.enableOOMDiagnostics`，**默认关闭**。
当且仅当开启时，才会启动 CDP 采样和轮询，确保对 99.9% 的普通用户毫无影响。遇到特定内存泄漏的用户时，只需让他们开启该设置，就能默默捕获数据。

---

## 4. 如何使用与排查定位

### 4.1 触发与收集
1. **开启监控**：在 VS Code 中打开设置（Settings），搜索 `developer.enableOOMDiagnostics` 并打勾。
2. **模拟/重现 OOM**：
   - 开发者可以通过 `F1` 运行 `Developer: Trigger Pure OOM Crash` 来模拟渲染进程泄漏。
   - 真实用户则只需正常使用，直到进程濒临崩溃。
3. **获取产物**：当渲染进程内存超过 1.5GB 临界点时，系统会在操作系统的临时目录（例如 Windows 下的 `C:\Users\<User>\AppData\Local\Temp\vscode-oom-diagnostics`）下自动生成两个文件：
   - `Renderer-RendererOOM-<timestamp>-sampling.json`
   - `Renderer-RendererOOM-<timestamp>-breadcrumbs.json`

### 4.2 分析与定位
1. **查看业务轨迹**：
   打开 `breadcrumbs.json`，里面记录了崩溃前最后 N 个系统或业务事件（如切换编辑器、触发补全等），帮助你重构出当时的业务场景。
2. **分析内存火焰图**：
   - 将 `sampling.json` 拖入浏览器（例如 [Speedscope](https://www.speedscope.app/)，或者 Chrome DevTools -> Memory -> Load）。
   - 在图表中，你可以清晰地看到整个进程生命周期中，**哪些函数调用**导致了大量的内存分配。图表会显示出分配最密集的“热点（Hotspots）”，例如可能是一个无限循环的 Array Push，或者是一个未能释放的 DOM 节点引用。
   - 结合 Breadcrumbs 的上下文，即可精准定位并修复渲染进程的内存泄漏根源。

## 5. 总结

这套方案完美避开了沙盒限制，没有粗暴破坏应用安全性。它通过 **“主控采样 + 辅进程轮询 + 动态频率 + 零干扰落盘”** 的精巧设计，为 Electron 渲染进程的 OOM 难题提供了一套真正适用于生产环境、用户无感知且高度自动化的现代排查工具。