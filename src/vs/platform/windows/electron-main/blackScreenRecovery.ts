/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import electron, { BrowserWindow } from 'electron';
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isWindows } from '../../../base/common/platform.js';

export type BlackScreenRecoveryStrategy =
	| 'off'
	| 'diagnose'
	| 'visibility-pulse'
	| 'native-occlusion-off'
	| 'renderer-backgrounding-off'
	| 'bounds-nudge'
	| 'aggressive';

type BlackScreenRecoveryStrategySource = 'argv' | 'codearts-env' | 'vscode-env' | 'setting' | 'default';

interface IBlackScreenRecoveryStrategyResolution {
	readonly strategy: BlackScreenRecoveryStrategy;
	readonly source: BlackScreenRecoveryStrategySource;
	readonly raw: string;
	readonly configuredStrategy: string | undefined;
	readonly configuredStrategyIgnored: boolean;
	readonly configuredStrategyIgnoredReason: string | undefined;
}

const validStrategies = new Set<string>([
	'off',
	'diagnose',
	'visibility-pulse',
	'native-occlusion-off',
	'renderer-backgrounding-off',
	'bounds-nudge',
	'aggressive'
]);

const sampleDelaysMs = [0, 1000, 2000, 5000, 10000, 20000, 30000, 60000];
const statePollIntervalMs = 5000;
const maxGpuCacheFilesToSummarize = 5000;
const maxGpuCacheFilesToLog = 25;

let installedStartupSwitches = false;
let installedAppWindowHook = false;
let probeRunDirectory: string | undefined;
let probeRootDirectory: string | undefined;
const installedProbeWindows = new WeakSet<BrowserWindow>();

export function getBlackScreenRecoveryStrategy(): BlackScreenRecoveryStrategy {
	return resolveBlackScreenRecoveryStrategy(undefined).strategy;
}

export function getConfiguredBlackScreenRecoveryStrategy(configuredStrategy: string | undefined): BlackScreenRecoveryStrategy {
	return resolveBlackScreenRecoveryStrategy(configuredStrategy).strategy;
}

function resolveBlackScreenRecoveryStrategy(configuredStrategy: string | undefined): IBlackScreenRecoveryStrategyResolution {
	const explicitStrategy = getExplicitBlackScreenRecoveryStrategy();
	if (explicitStrategy) {
		return {
			strategy: normalizeBlackScreenRecoveryStrategy(explicitStrategy.raw),
			source: explicitStrategy.source,
			raw: explicitStrategy.raw,
			configuredStrategy,
			configuredStrategyIgnored: false,
			configuredStrategyIgnoredReason: undefined
		};
	}

	if (configuredStrategy && configuredStrategy !== 'off') {
		return {
			strategy: normalizeBlackScreenRecoveryStrategy(configuredStrategy),
			source: 'setting',
			raw: configuredStrategy,
			configuredStrategy,
			configuredStrategyIgnored: false,
			configuredStrategyIgnoredReason: undefined
		};
	}

	return {
		strategy: 'diagnose',
		source: 'default',
		raw: 'diagnose',
		configuredStrategy,
		configuredStrategyIgnored: configuredStrategy === 'off',
		configuredStrategyIgnoredReason: configuredStrategy === 'off' ? 'settingOffDoesNotDisableDefaultDiagnosticBuild' : undefined
	};
}

function normalizeBlackScreenRecoveryStrategy(raw: string): BlackScreenRecoveryStrategy {
	if (validStrategies.has(raw)) {
		return raw as BlackScreenRecoveryStrategy;
	}

	writeBlackScreenEvent('blackScreenRecovery.invalidStrategy', { raw });
	return 'off';
}

function getExplicitBlackScreenRecoveryStrategy(): { raw: string; source: BlackScreenRecoveryStrategySource } | undefined {
	const arg = getBlackScreenRecoveryStrategyArg();
	if (arg) {
		return { raw: arg, source: 'argv' };
	}

	const codeArtsEnv = process.env['CODEARTS_BLACK_SCREEN_RECOVERY'];
	if (codeArtsEnv) {
		return { raw: codeArtsEnv, source: 'codearts-env' };
	}

	const vscodeEnv = process.env['VSCODE_BLACK_SCREEN_RECOVERY'];
	if (vscodeEnv) {
		return { raw: vscodeEnv, source: 'vscode-env' };
	}

	return undefined;
}

function getBlackScreenRecoveryStrategyArg(): string | undefined {
	for (let i = 0; i < process.argv.length; i++) {
		const arg = process.argv[i];
		const match = arg.match(/^--black-screen-recovery=(.+)$/);
		if (match) {
			return match[1];
		}
		if (arg === '--black-screen-recovery') {
			return process.argv[i + 1];
		}
	}

	return undefined;
}

export function applyBlackScreenRecoveryStartupSwitches(strategy = getBlackScreenRecoveryStrategy()): void {
	if (installedStartupSwitches || !isWindows) {
		return;
	}

	installedStartupSwitches = true;

	const switches: string[] = [];
	const disableFeaturesBefore = electron.app.commandLine.getSwitchValue('disable-features');

	if (strategy === 'native-occlusion-off' || strategy === 'aggressive') {
		appendDisableFeature('CalculateNativeWinOcclusion');
		switches.push('--disable-features=CalculateNativeWinOcclusion');
	}

	if (strategy === 'renderer-backgrounding-off') {
		electron.app.commandLine.appendSwitch('disable-renderer-backgrounding');
		switches.push('--disable-renderer-backgrounding');
	}

	writeBlackScreenEvent('blackScreenRecovery.startupSwitches', {
		strategy,
		switches,
		disableFeaturesBefore,
		disableFeaturesAfter: electron.app.commandLine.getSwitchValue('disable-features'),
		rendererBackgroundingDisabled: electron.app.commandLine.hasSwitch('disable-renderer-backgrounding'),
		paths: getAppPathSnapshot(),
		gpuCache: getGpuCacheSnapshot(),
		argv: process.argv
	});

	installBlackScreenRecoveryAppWindowHook(strategy);
}

export function logBlackScreenRecoveryWindowHook(label: string, configuredStrategy?: string): void {
	writeBlackScreenEvent('blackScreenRecovery.windowHook', {
		label,
		isWindows,
		configuredStrategy,
		resolution: resolveBlackScreenRecoveryStrategy(configuredStrategy)
	});
}

export function installBlackScreenRecoveryProbe(win: BrowserWindow, label = 'main', configuredStrategy?: string): void {
	const strategyResolution = resolveBlackScreenRecoveryStrategy(configuredStrategy);
	const strategy = strategyResolution.strategy;

	writeBlackScreenEvent('blackScreenRecovery.installAttempt', {
		label,
		isWindows,
		strategy,
		strategyResolution,
		window: getWindowSnapshot(win),
		display: getDisplaySnapshot(win)
	});

	if (installedProbeWindows.has(win)) {
		writeBlackScreenEvent('blackScreenRecovery.installSkipped', {
			label,
			isWindows,
			strategy,
			strategyResolution,
			reason: 'duplicateWindow'
		});
		return;
	}

	if (strategy === 'off' || !isWindows) {
		writeBlackScreenEvent('blackScreenRecovery.installSkipped', {
			label,
			isWindows,
			strategy,
			strategyResolution,
			reason: strategy === 'off' ? 'strategyOff' : 'notWindows'
		});
		return;
	}

	installedProbeWindows.add(win);

	const state = {
		lastNudgeAt: 0,
		sampleGeneration: 0,
		initialGpuCache: getGpuCacheSnapshot(),
		lastWindowStateKey: ''
	};

	const logSnapshot = (event: string, data: Record<string, unknown> = {}) => {
		writeBlackScreenEvent(event, {
			label,
			strategy,
			window: getWindowSnapshot(win),
			display: getDisplaySnapshot(win),
			...data
		});
	};

	const scheduleSamples = (reason: string) => {
		const generation = ++state.sampleGeneration;
		for (const delayMs of sampleDelaysMs) {
			setTimeout(() => {
				if (generation !== state.sampleGeneration || win.isDestroyed()) {
					return;
				}
				sampleWindow(win, strategy, reason, delayMs, state).catch(error => {
					writeBlackScreenEvent('blackScreenRecovery.sample.error', {
						label,
						strategy,
						reason,
						delayMs,
						error: getErrorMessage(error)
					});
				});
			}, delayMs);
		}
	};

	const onVisibleTransition = (reason: string) => {
		logSnapshot(`blackScreenRecovery.window.${reason}`);
		scheduleSamples(reason);

		if (strategy === 'visibility-pulse' || strategy === 'aggressive') {
			runVisibilityPulse(win, reason).catch(error => {
				writeBlackScreenEvent('blackScreenRecovery.visibilityPulse.error', {
					label,
					strategy,
					reason,
					error: getErrorMessage(error)
				});
			});
		}
	};

	onBrowserWindowEvent(win, 'show', () => onVisibleTransition('show'));
	onBrowserWindowEvent(win, 'restore', () => onVisibleTransition('restore'));
	onBrowserWindowEvent(win, 'maximize', () => onVisibleTransition('maximize'));
	onBrowserWindowEvent(win, 'focus', () => onVisibleTransition('focus'));
	onBrowserWindowEvent(win, 'hide', () => logSnapshot('blackScreenRecovery.window.hide'));
	onBrowserWindowEvent(win, 'minimize', () => logSnapshot('blackScreenRecovery.window.minimize'));
	onBrowserWindowEvent(win, 'unmaximize', () => logSnapshot('blackScreenRecovery.window.unmaximize'));
	onBrowserWindowEvent(win, 'blur', () => logSnapshot('blackScreenRecovery.window.blur'));
	onBrowserWindowEvent(win, 'resize', () => logSnapshot('blackScreenRecovery.window.resize'));
	onBrowserWindowEvent(win, 'move', () => logSnapshot('blackScreenRecovery.window.move'));
	onBrowserWindowEvent(win, 'enter-full-screen', () => logSnapshot('blackScreenRecovery.window.enter-full-screen'));
	onBrowserWindowEvent(win, 'leave-full-screen', () => logSnapshot('blackScreenRecovery.window.leave-full-screen'));

	const webContents = win.webContents;
	webContents.on('unresponsive', () => logSnapshot('blackScreenRecovery.webContents.unresponsive', getWebContentsSnapshot(win)));
	webContents.on('responsive', () => logSnapshot('blackScreenRecovery.webContents.responsive', getWebContentsSnapshot(win)));
	webContents.on('render-process-gone', (_event, details) => logSnapshot('blackScreenRecovery.webContents.renderProcessGone', {
		...getWebContentsSnapshot(win),
		details
	}));
	webContents.on('destroyed', () => logSnapshot('blackScreenRecovery.webContents.destroyed', getWebContentsSnapshot(win)));
	webContents.on('did-finish-load', () => logSnapshot('blackScreenRecovery.webContents.didFinishLoad', getWebContentsSnapshot(win)));

	logSnapshot('blackScreenRecovery.installed', {
		paths: getAppPathSnapshot(),
		commandLine: getCommandLineSnapshot(),
		gpuFeatureStatus: safeCall(() => electron.app.getGPUFeatureStatus()),
		appMetrics: getAppMetricsSnapshot(),
		gpuCache: state.initialGpuCache
	});
	logGpuInfoComplete(strategy, label);
	startWindowStatePolling(win, strategy, label, state);
	scheduleSamples('installed');
}

function installBlackScreenRecoveryAppWindowHook(startupStrategy: BlackScreenRecoveryStrategy): void {
	if (installedAppWindowHook || !isWindows) {
		return;
	}

	if (startupStrategy === 'off') {
		writeBlackScreenEvent('blackScreenRecovery.appWindowHook.skipped', {
			startupStrategy,
			reason: 'startupStrategyOff'
		});
		return;
	}

	installedAppWindowHook = true;
	writeBlackScreenEvent('blackScreenRecovery.appWindowHook.installed', {
		startupStrategy
	});

	(electron.app as unknown as { on(eventName: string, listener: (event: unknown, win: BrowserWindow) => void): void }).on('browser-window-created', (_event, win) => {
		writeBlackScreenEvent('blackScreenRecovery.appWindowCreated', {
			startupStrategy,
			window: getWindowSnapshot(win),
			display: getDisplaySnapshot(win)
		});
		setTimeout(() => {
			if (!win.isDestroyed()) {
				installBlackScreenRecoveryProbe(win, 'app.browser-window-created', startupStrategy);
			}
		}, 0);
	});
}

function onBrowserWindowEvent(win: BrowserWindow, eventName: string, listener: () => void): void {
	(win as unknown as { on(eventName: string, listener: () => void): void }).on(eventName, listener);
}

function startWindowStatePolling(win: BrowserWindow, strategy: BlackScreenRecoveryStrategy, label: string, state: { lastWindowStateKey: string }): void {
	const poll = () => {
		if (win.isDestroyed()) {
			return;
		}

		const windowSnapshot = getWindowSnapshot(win);
		const stateKey = JSON.stringify({
			isVisible: windowSnapshot['isVisible'],
			isMinimized: windowSnapshot['isMinimized'],
			isMaximized: windowSnapshot['isMaximized'],
			isFullScreen: windowSnapshot['isFullScreen'],
			isFocused: windowSnapshot['isFocused'],
			bounds: windowSnapshot['bounds']
		});

		if (state.lastWindowStateKey !== stateKey) {
			state.lastWindowStateKey = stateKey;
			writeBlackScreenEvent('blackScreenRecovery.window.state', {
				label,
				strategy,
				window: windowSnapshot,
				display: getDisplaySnapshot(win)
			});
		}

		setTimeout(poll, statePollIntervalMs);
	};

	setTimeout(poll, 0);
}

function appendDisableFeature(feature: string): void {
	const current = electron.app.commandLine.getSwitchValue('disable-features');
	const features = new Set(current.split(',').map(value => value.trim()).filter(Boolean));
	features.add(feature);
	electron.app.commandLine.appendSwitch('disable-features', Array.from(features).join(','));
}

async function sampleWindow(
	win: BrowserWindow,
	strategy: BlackScreenRecoveryStrategy,
	reason: string,
	delayMs: number,
	state: { lastNudgeAt: number; initialGpuCache: Record<string, unknown> }
): Promise<void> {
	await ensureRendererProbe(win);

	const gpuCache = getGpuCacheSnapshot();
	const [rendererState, captureState] = await Promise.all([
		getRendererState(win),
		getCaptureBlackState(win)
	]);

	writeBlackScreenEvent('blackScreenRecovery.sample', {
		strategy,
		reason,
		delayMs,
		window: getWindowSnapshot(win),
		display: getDisplaySnapshot(win),
		webContents: getWebContentsSnapshot(win),
		appMetrics: getAppMetricsSnapshot(),
		gpuCache,
		gpuCacheChangedFromInstall: didGpuCacheChange(state.initialGpuCache, gpuCache),
		renderer: rendererState,
		capture: captureState
	});

	if ((strategy === 'bounds-nudge' || strategy === 'aggressive') && captureState?.isBlack) {
		await maybeNudgeBounds(win, strategy, reason, captureState.blackRatio, state);
	}

	if (captureState?.isBlack) {
		writeBlackScreenEvent('blackScreenRecovery.captureBlackHit', {
			strategy,
			reason,
			delayMs,
			window: getWindowSnapshot(win),
			display: getDisplaySnapshot(win),
			webContents: getWebContentsSnapshot(win),
			renderer: rendererState,
			capture: captureState,
			paths: getAppPathSnapshot(),
			commandLine: getCommandLineSnapshot(),
			gpuFeatureStatus: safeCall(() => electron.app.getGPUFeatureStatus()),
			appMetrics: getAppMetricsSnapshot(),
			gpuCache
		});
	}
}

async function ensureRendererProbe(win: BrowserWindow): Promise<void> {
	if (win.isDestroyed() || win.webContents.isDestroyed()) {
		return;
	}

	await win.webContents.executeJavaScript(`
		(() => {
			if (window.__codeartsBlackScreenProbeInstalled) {
				return true;
			}
			window.__codeartsBlackScreenProbeInstalled = true;
			window.__codeartsBlackScreenProbe = {
				installedAt: performance.now(),
				lastRafAt: performance.now(),
				lastMutationAt: performance.now()
			};
			const loop = () => {
				window.__codeartsBlackScreenProbe.lastRafAt = performance.now();
				requestAnimationFrame(loop);
			};
			requestAnimationFrame(loop);
			try {
				const observer = new MutationObserver(() => {
					window.__codeartsBlackScreenProbe.lastMutationAt = performance.now();
				});
				observer.observe(document.documentElement, {
					childList: true,
					subtree: true,
					attributes: true,
					characterData: true
				});
				window.__codeartsBlackScreenProbe.observer = observer;
			} catch {
				// best effort
			}
			return true;
		})()
	`, true);
}

async function getRendererState(win: BrowserWindow): Promise<Record<string, unknown> | undefined> {
	if (win.isDestroyed() || win.webContents.isDestroyed()) {
		return undefined;
	}

	try {
		return await win.webContents.executeJavaScript(`
			(() => {
				const now = performance.now();
				const probe = window.__codeartsBlackScreenProbe;
				return {
					now,
					url: location.href,
					title: document.title,
					visibilityState: document.visibilityState,
					hasFocus: document.hasFocus(),
					viewport: {
						width: window.innerWidth,
						height: window.innerHeight,
						devicePixelRatio: window.devicePixelRatio
					},
					bodyTextLength: document.body ? document.body.innerText.length : 0,
					rafAgeMs: probe ? Math.round(now - probe.lastRafAt) : null,
					mutationAgeMs: probe ? Math.round(now - probe.lastMutationAt) : null
				};
			})()
		`, true);
	} catch (error) {
		return { error: getErrorMessage(error) };
	}
}

async function runVisibilityPulse(win: BrowserWindow, reason: string): Promise<void> {
	if (win.isDestroyed() || win.webContents.isDestroyed()) {
		return;
	}

	const result = await win.webContents.executeJavaScript(`
		(async () => {
			const startedAt = performance.now();
			const marker = document.createElement('div');
			marker.setAttribute('data-black-screen-pulse', ${JSON.stringify(reason)});
			marker.style.cssText = [
				'position:fixed',
				'left:0',
				'top:0',
				'width:1px',
				'height:1px',
				'opacity:0',
				'pointer-events:none',
				'z-index:2147483647'
			].join(';');
			document.documentElement.appendChild(marker);
			document.body?.getBoundingClientRect();
			await new Promise(resolve => {
				let done = false;
				const finish = () => {
					if (!done) {
						done = true;
						resolve(undefined);
					}
				};
				requestAnimationFrame(() => requestAnimationFrame(finish));
				setTimeout(finish, 1000);
			});
			marker.remove();
			return {
				startedAt,
				endedAt: performance.now(),
				visibilityState: document.visibilityState,
				hasFocus: document.hasFocus()
			};
		})()
	`, true);

	writeBlackScreenEvent('blackScreenRecovery.visibilityPulse.done', {
		reason,
		result
	});
}

async function getCaptureBlackState(win: BrowserWindow): Promise<{ width: number; height: number; blackRatio: number; isBlack: boolean; error?: string } | undefined> {
	if (win.isDestroyed() || win.webContents.isDestroyed()) {
		return undefined;
	}

	try {
		const image = await win.webContents.capturePage();
		const size = image.getSize();
		const bitmap = image.toBitmap();
		const pixelCount = Math.max(1, size.width * size.height);
		const sampleStep = Math.max(1, Math.floor(Math.sqrt(pixelCount / 20000)));

		let black = 0;
		let total = 0;

		for (let y = 0; y < size.height; y += sampleStep) {
			for (let x = 0; x < size.width; x += sampleStep) {
				const offset = (y * size.width + x) * 4;
				const b0 = bitmap[offset] ?? 255;
				const b1 = bitmap[offset + 1] ?? 255;
				const b2 = bitmap[offset + 2] ?? 255;
				if (b0 < 18 && b1 < 18 && b2 < 18) {
					black++;
				}
				total++;
			}
		}

		const blackRatio = total > 0 ? Math.round((black / total) * 10000) / 10000 : 0;
		return {
			width: size.width,
			height: size.height,
			blackRatio,
			isBlack: blackRatio >= 0.8
		};
	} catch (error) {
		return {
			width: 0,
			height: 0,
			blackRatio: 0,
			isBlack: false,
			error: getErrorMessage(error)
		};
	}
}

async function maybeNudgeBounds(
	win: BrowserWindow,
	strategy: BlackScreenRecoveryStrategy,
	reason: string,
	captureBeforeBlackRatio: number,
	state: { lastNudgeAt: number }
): Promise<void> {
	const now = Date.now();
	if (now - state.lastNudgeAt < 30000) {
		return;
	}
	if (win.isDestroyed() || win.isMinimized() || win.isFullScreen() || !win.isVisible()) {
		return;
	}

	state.lastNudgeAt = now;
	const originalBounds = win.getBounds();

	writeBlackScreenEvent('blackScreenRecovery.boundsNudge.begin', {
		strategy,
		reason,
		captureBeforeBlackRatio,
		bounds: originalBounds
	});

	win.setBounds({ ...originalBounds, width: Math.max(1, originalBounds.width - 1) }, false);
	await sleep(80);
	win.setBounds(originalBounds, false);
	await sleep(250);

	const after = await getCaptureBlackState(win);
	writeBlackScreenEvent('blackScreenRecovery.boundsNudge.end', {
		strategy,
		reason,
		captureBeforeBlackRatio,
		captureAfter: after,
		bounds: getWindowSnapshot(win)
	});
}

function getWindowSnapshot(win: BrowserWindow): Record<string, unknown> {
	return {
		id: win.id,
		isDestroyed: win.isDestroyed(),
		isVisible: safeCall(() => win.isVisible()),
		isMinimized: safeCall(() => win.isMinimized()),
		isMaximized: safeCall(() => win.isMaximized()),
		isFullScreen: safeCall(() => win.isFullScreen()),
		isFocused: safeCall(() => win.isFocused()),
		bounds: safeCall(() => win.getBounds()),
		contentBounds: safeCall(() => win.getContentBounds()),
		normalBounds: safeCall(() => win.getNormalBounds())
	};
}

function getDisplaySnapshot(win: BrowserWindow): Record<string, unknown> | undefined {
	return safeCall(() => {
		const display = electron.screen.getDisplayMatching(win.getBounds());
		return {
			id: display.id,
			bounds: display.bounds,
			workArea: display.workArea,
			scaleFactor: display.scaleFactor,
			rotation: display.rotation
		};
	});
}

function getWebContentsSnapshot(win: BrowserWindow): Record<string, unknown> {
	const webContents = win.webContents;
	return {
		webContentsId: webContents.id,
		isDestroyed: webContents.isDestroyed(),
		isLoading: safeCall(() => webContents.isLoading()),
		isCrashed: safeCall(() => webContents.isCrashed()),
		url: safeCall(() => webContents.getURL())
	};
}

function getAppPathSnapshot(): Record<string, unknown> {
	return {
		userData: getAppPath('userData'),
		sessionData: getAppPath('sessionData'),
		cache: getAppPath('cache'),
		temp: getAppPath('temp')
	};
}

function getAppPath(name: string): string | undefined {
	return safeCall(() => (electron.app.getPath as (pathName: string) => string)(name));
}

function getCommandLineSnapshot(): Record<string, unknown> {
	return {
		disableFeatures: electron.app.commandLine.getSwitchValue('disable-features'),
		enableFeatures: electron.app.commandLine.getSwitchValue('enable-features'),
		disableBlinkFeatures: electron.app.commandLine.getSwitchValue('disable-blink-features'),
		disableRendererBackgrounding: electron.app.commandLine.hasSwitch('disable-renderer-backgrounding'),
		disableGpu: electron.app.commandLine.hasSwitch('disable-gpu'),
		disableGpuCompositing: electron.app.commandLine.hasSwitch('disable-gpu-compositing'),
		disableSoftwareRasterizer: electron.app.commandLine.hasSwitch('disable-software-rasterizer'),
		inProcessGpu: electron.app.commandLine.hasSwitch('in-process-gpu')
	};
}

function getAppMetricsSnapshot(): Record<string, unknown>[] | undefined {
	return safeCall(() => electron.app.getAppMetrics() as unknown as Record<string, unknown>[]);
}

function getGpuCacheSnapshot(): Record<string, unknown> {
	const paths = getGpuCachePaths();
	return {
		paths,
		summaries: paths.map(cachePath => summarizeDirectory(cachePath))
	};
}

function getGpuCachePaths(): string[] {
	const candidates = new Set<string>();
	const userData = getAppPath('userData');
	const sessionData = getAppPath('sessionData');
	const cache = getAppPath('cache');

	if (userData) {
		candidates.add(join(userData, 'GPUCache'));
	}
	if (sessionData) {
		candidates.add(join(sessionData, 'GPUCache'));
	}
	if (cache) {
		candidates.add(join(cache, 'GPUCache'));
	}

	return Array.from(candidates);
}

function summarizeDirectory(directory: string): Record<string, unknown> {
	const summary = {
		path: directory,
		exists: false,
		fileCount: 0,
		totalBytes: 0,
		latestWriteTime: undefined as string | undefined,
		truncated: false,
		sampleFiles: [] as Record<string, unknown>[],
		error: undefined as string | undefined
	};

	try {
		if (!existsSync(directory)) {
			return summary;
		}

		summary.exists = true;
		const files: { path: string; size: number; mtimeMs: number }[] = [];
		walkDirectory(directory, directory, files, summary);

		summary.sampleFiles = files
			.sort((a, b) => b.size - a.size)
			.slice(0, maxGpuCacheFilesToLog)
			.map(file => ({
				path: file.path,
				size: file.size,
				lastWriteTime: new Date(file.mtimeMs).toISOString()
			}));
	} catch (error) {
		summary.error = getErrorMessage(error);
	}

	return summary;
}

function walkDirectory(root: string, current: string, files: { path: string; size: number; mtimeMs: number }[], summary: { fileCount: number; totalBytes: number; latestWriteTime?: string; truncated: boolean }): void {
	if (summary.truncated) {
		return;
	}

	for (const entry of readdirSync(current, { withFileTypes: true })) {
		if (summary.fileCount >= maxGpuCacheFilesToSummarize) {
			summary.truncated = true;
			return;
		}

		const fullPath = join(current, entry.name);
		if (entry.isDirectory()) {
			walkDirectory(root, fullPath, files, summary);
			continue;
		}

		if (!entry.isFile()) {
			continue;
		}

		const stat = statSync(fullPath);
		summary.fileCount++;
		summary.totalBytes += stat.size;
		if (!summary.latestWriteTime || stat.mtimeMs > Date.parse(summary.latestWriteTime)) {
			summary.latestWriteTime = stat.mtime.toISOString();
		}
		files.push({
			path: fullPath.substring(root.length + 1),
			size: stat.size,
			mtimeMs: stat.mtimeMs
		});
	}
}

function didGpuCacheChange(initialGpuCache: Record<string, unknown>, currentGpuCache: Record<string, unknown>): boolean {
	return JSON.stringify(getGpuCacheChangeKey(initialGpuCache)) !== JSON.stringify(getGpuCacheChangeKey(currentGpuCache));
}

function getGpuCacheChangeKey(snapshot: Record<string, unknown>): unknown {
	const summaries = snapshot['summaries'];
	if (!Array.isArray(summaries)) {
		return undefined;
	}

	return summaries.map(summary => {
		if (!summary || typeof summary !== 'object') {
			return undefined;
		}
		const value = summary as Record<string, unknown>;
		return {
			path: value['path'],
			exists: value['exists'],
			fileCount: value['fileCount'],
			totalBytes: value['totalBytes'],
			latestWriteTime: value['latestWriteTime'],
			truncated: value['truncated']
		};
	});
}

function logGpuInfoComplete(strategy: BlackScreenRecoveryStrategy, label: string): void {
	electron.app.getGPUInfo('complete').then(info => {
		writeBlackScreenEvent('blackScreenRecovery.gpuInfoComplete', {
			strategy,
			label,
			info
		});
	}, error => {
		writeBlackScreenEvent('blackScreenRecovery.gpuInfoComplete.error', {
			strategy,
			label,
			error: getErrorMessage(error)
		});
	});
}

function writeBlackScreenEvent(event: string, data: Record<string, unknown> = {}): void {
	try {
		const dir = getProbeRunDirectory();
		mkdirSync(dir, { recursive: true });
		const record = {
			time: new Date().toISOString(),
			t: Date.now(),
			pid: process.pid,
			event,
			runDirectory: dir,
			data
		};
		appendFileSync(join(dir, 'events.ndjson'), `${JSON.stringify(record)}\n`, 'utf8');
		if (isWindowProbeEvent(event)) {
			writeLatestWindowRun(dir);
		}
	} catch {
		// Never let diagnostic logging affect the product.
	}
}

function getProbeRunDirectory(): string {
	if (probeRunDirectory) {
		return probeRunDirectory;
	}

	const explicitDir = process.env['CODEARTS_BLACK_SCREEN_PROBE_DIR']
		|| process.env['VSCODE_BLACK_SCREEN_PROBE_DIR'];
	if (explicitDir) {
		probeRunDirectory = explicitDir;
		return probeRunDirectory;
	}

	const root = getProbeRootDirectory();
	const runId = `${formatDateForPath(new Date())}-${process.pid}`;
	probeRunDirectory = join(root, 'runs', runId);

	try {
		mkdirSync(root, { recursive: true });
		appendFileSync(join(root, 'latest-run.txt'), `${probeRunDirectory}\n`, 'utf8');
	} catch {
		// best effort
	}

	return probeRunDirectory;
}

function getProbeRootDirectory(): string {
	if (!probeRootDirectory) {
		probeRootDirectory = join(tmpdir(), 'codearts-black-screen-probe');
	}

	return probeRootDirectory;
}

function isWindowProbeEvent(event: string): boolean {
	return event === 'blackScreenRecovery.appWindowCreated'
		|| event === 'blackScreenRecovery.windowHook'
		|| event === 'blackScreenRecovery.installAttempt'
		|| event === 'blackScreenRecovery.installed'
		|| event === 'blackScreenRecovery.sample'
		|| event === 'blackScreenRecovery.window.state'
		|| event === 'blackScreenRecovery.captureBlackHit';
}

function writeLatestWindowRun(runDirectory: string): void {
	try {
		const root = getProbeRootDirectory();
		mkdirSync(root, { recursive: true });
		appendFileSync(join(root, 'latest-window-run.txt'), `${runDirectory}\n`, 'utf8');
	} catch {
		// best effort
	}
}

function formatDateForPath(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, '0');
	return [
		date.getFullYear(),
		pad(date.getMonth() + 1),
		pad(date.getDate())
	].join('') + '-' + [
		pad(date.getHours()),
		pad(date.getMinutes()),
		pad(date.getSeconds())
	].join('');
}

function safeCall<T>(fn: () => T): T | undefined {
	try {
		return fn();
	} catch {
		return undefined;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.stack || error.message;
	}
	return String(error);
}
