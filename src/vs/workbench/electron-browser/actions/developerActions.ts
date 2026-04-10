/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../nls.js';
import { INativeHostService } from '../../../platform/native/common/native.js';
import { IEditorService } from '../../services/editor/common/editorService.js';
import { Action2, MenuId } from '../../../platform/actions/common/actions.js';
import { Categories } from '../../../platform/action/common/actionCommonCategories.js';
import { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchEnvironmentService } from '../../services/environment/common/environmentService.js';
import { KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { IsDevelopmentContext } from '../../../platform/contextkey/common/contextkeys.js';
import { KeyCode, KeyMod } from '../../../base/common/keyCodes.js';
import { INativeWorkbenchEnvironmentService } from '../../services/environment/electron-browser/environmentService.js';
import { URI } from '../../../base/common/uri.js';
import { getActiveWindow } from '../../../base/browser/dom.js';
import { IDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { INativeEnvironmentService } from '../../../platform/environment/common/environment.js';
import { IProgressService, ProgressLocation } from '../../../platform/progress/common/progress.js';

export class ToggleDevToolsAction extends Action2 {

	constructor() {
		super({
			id: 'workbench.action.toggleDevTools',
			title: localize2('toggleDevTools', 'Toggle Developer Tools'),
			category: Categories.Developer,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib + 50,
				when: IsDevelopmentContext,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyI,
				mac: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyI }
			},
			menu: {
				id: MenuId.MenubarHelpMenu,
				group: '5_tools',
				order: 1
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const nativeHostService = accessor.get(INativeHostService);

		return nativeHostService.toggleDevTools({ targetWindowId: getActiveWindow().vscodeWindowId });
	}
}

export class ConfigureRuntimeArgumentsAction extends Action2 {

	constructor() {
		super({
			id: 'workbench.action.configureRuntimeArguments',
			title: localize2('configureRuntimeArguments', 'Configure Runtime Arguments'),
			category: Categories.Preferences,
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const environmentService = accessor.get(IWorkbenchEnvironmentService);

		await editorService.openEditor({
			resource: environmentService.argvResource,
			options: { pinned: true }
		});
	}
}

export class ReloadWindowWithExtensionsDisabledAction extends Action2 {

	constructor() {
		super({
			id: 'workbench.action.reloadWindowWithExtensionsDisabled',
			title: localize2('reloadWindowWithExtensionsDisabled', 'Reload with Extensions Disabled'),
			category: Categories.Developer,
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(INativeHostService).reload({ disableExtensions: true });
	}
}

export class OpenUserDataFolderAction extends Action2 {

	constructor() {
		super({
			id: 'workbench.action.revealUserDataFolder',
			title: localize2('revealUserDataFolder', 'Reveal User Data Folder'),
			category: Categories.Developer,
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const nativeHostService = accessor.get(INativeHostService);
		const environmentService = accessor.get(INativeWorkbenchEnvironmentService);

		return nativeHostService.showItemInFolder(URI.file(environmentService.userDataPath).fsPath);
	}
}

export class ShowGPUInfoAction extends Action2 {

	constructor() {
		super({
			id: 'workbench.action.showGPUInfo',
			title: localize2('showGPUInfo', 'Show GPU Info'),
			category: Categories.Developer,
			f1: true
		});
	}

	run(accessor: ServicesAccessor) {
		const nativeHostService = accessor.get(INativeHostService);
		nativeHostService.openGPUInfoWindow();
	}
}

export class ShowContentTracingAction extends Action2 {

	constructor() {
		super({
			id: 'workbench.action.showContentTracing',
			title: localize2('showContentTracing', 'Show Content Tracing'),
			category: Categories.Developer,
			f1: true
		});
	}

	run(accessor: ServicesAccessor) {
		const nativeHostService = accessor.get(INativeHostService);
		nativeHostService.openContentTracingWindow();
	}
}

export class StopTracing extends Action2 {

	static readonly ID = 'workbench.action.stopTracing';

	constructor() {
		super({
			id: StopTracing.ID,
			title: localize2('stopTracing', 'Stop Tracing'),
			category: Categories.Developer,
			f1: true
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const environmentService = accessor.get(INativeEnvironmentService);
		const dialogService = accessor.get(IDialogService);
		const nativeHostService = accessor.get(INativeHostService);
		const progressService = accessor.get(IProgressService);

		if (!environmentService.args.trace) {
			const { confirmed } = await dialogService.confirm({
				message: localize('stopTracing.message', "Tracing requires to launch with a '--trace' argument"),
				primaryButton: localize({ key: 'stopTracing.button', comment: ['&& denotes a mnemonic'] }, "&&Relaunch and Enable Tracing"),
			});

			if (confirmed) {
				return nativeHostService.relaunch({ addArgs: ['--trace'] });
			}
		}

		await progressService.withProgress({
			location: ProgressLocation.Dialog,
			title: localize('stopTracing.title', "Creating trace file..."),
			cancellable: false,
			detail: localize('stopTracing.detail', "This can take up to one minute to complete.")
		}, () => nativeHostService.stopTracing());
	}
}

export class TriggerRendererOOMAction extends Action2 {

	constructor() {
		super({
			id: 'workbench.action.triggerRendererOOM',
			title: localize2('triggerRendererOOM', 'Developer: Trigger Renderer OOM'),
			category: Categories.Developer,
			f1: true
		});
	}

	run(accessor: ServicesAccessor): void {
		const arr: string[] = [];
		const mainWindow = (globalThis as unknown as { window: Window & { __oom_leak_arr?: string[] } }).window;
		if (mainWindow) {
			mainWindow.__oom_leak_arr = arr;
		}

		const leak = () => {
			let currentMB = 0;

			// Try to get current memory to adjust leak speed
			const vscodeProcess = (globalThis as unknown as { vscode?: { process?: { getProcessMemoryInfo?: () => Promise<{ private: number }> } } }).vscode?.process;
			if (vscodeProcess && typeof vscodeProcess.getProcessMemoryInfo === 'function') {
				vscodeProcess.getProcessMemoryInfo().then(info => {
					currentMB = Math.round(info.private / 1024);
					this.doLeak(arr, currentMB, leak);
				}).catch(() => this.doLeak(arr, 0, leak));
			} else {
				this.doLeak(arr, 0, leak);
			}
		};

		leak();
	}

	private doLeak(arr: string[], currentMB: number, next: () => void) {
		// If we don't know the memory or it's safely below 1.2GB, leak FAST (~500MB/s)
		// If we are getting close to the 1.5GB threshold, leak SLOW (~50MB/s) to let the monitor catch it
		const iterations = (currentMB === 0 || currentMB < 1200) ? 3000 : 50;

		for (let i = 0; i < iterations; i++) {
			arr.push(new Array(10000).join('OOM_TEST_DATA'));
		}

		// We don't stop leaking here because we WANT to simulate a real crash (white screen)
		// after the monitor has had a chance to trigger the heap snapshot.
		if (currentMB > 1800) {
			console.log(`[OOM Test] Memory at ${currentMB}MB. Approaching crash limit...`);
		}

		const mainWindow = (globalThis as unknown as { window: Window }).window;
		if (mainWindow) {
			mainWindow.setTimeout(next, 100);
		}
	}
}

export class TriggerPureOOMAction extends Action2 {

	constructor() {
		super({
			id: 'workbench.action.triggerPureOOM',
			title: localize2('triggerPureOOM', 'Developer: Trigger Pure OOM Crash'),
			category: Categories.Developer,
			f1: true
		});
	}

	override async run(): Promise<void> {
		console.log('[Pure OOM] Starting memory leak to simulate crash...');
		const leakArray: unknown[] = [];
		const vscodeProcess = (globalThis as unknown as { vscode?: { process?: { getProcessMemoryInfo?: () => Promise<{ private: number }> } } }).vscode?.process;

		const mainWindow = (globalThis as unknown as { window: Window }).window;
		if (mainWindow) {
			// Continue allocating memory until V8 crash
			const leakInterval = mainWindow.setInterval(async () => {
				try {
					// Allocate ~50MB of strings and objects per iteration
					for (let i = 0; i < 1000; i++) {
						leakArray.push(new Array(10000).fill('OOM_TEST_STRING_MEMORY_LEAK_SIMULATION_VSCODE'));
					}

					if (vscodeProcess && typeof vscodeProcess.getProcessMemoryInfo === 'function') {
						const info = await vscodeProcess.getProcessMemoryInfo();
						console.log(`[Pure OOM] Leaking... Private Memory: ${Math.round(info.private / 1024)} MB`);
					} else {
						console.log(`[Pure OOM] Leaking...`);
					}
				} catch (e) {
					console.error('Leak hit error early:', e);
					mainWindow.clearInterval(leakInterval);
				}
			}, 50); // Extremely fast leak
		}
	}
}
