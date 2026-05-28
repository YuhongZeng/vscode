/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BrowserWindow } from 'electron';
import { ILogService } from '../../log/common/log.js';
import { join } from '../../../base/common/path.js';
import { tmpdir } from 'os';
import { promises as fs } from 'fs';

export class HeapSamplingProfiler {
	private _isStarted = false;

	constructor(
		private readonly _window: BrowserWindow,
		@ILogService private readonly _logService: ILogService,
	) { }

	async start(): Promise<void> {
		if (this._isStarted) {
			return;
		}

		const inspector = this._window.webContents.debugger;
		try {
			if (!inspector.isAttached()) {
				inspector.attach();
			}
			await inspector.sendCommand('HeapProfiler.enable');
			// intervalBytes: 512KB (default) for low overhead allocation sampling
			await inspector.sendCommand('HeapProfiler.startSampling', { samplingInterval: 512 * 1024 });
			this._isStarted = true;
			this._logService.info('[OOM Monitor] CDP HeapProfiler.startSampling enabled for Renderer.');
		} catch (e) {
			this._logService.error('[OOM Monitor] Failed to start HeapSamplingProfiler via CDP:', e);
		}
	}

	async dumpProfile(reason: string): Promise<string> {
		if (!this._isStarted) {
			throw new Error('HeapSamplingProfiler is not started.');
		}

		const inspector = this._window.webContents.debugger;
		try {
			this._logService.warn(`[OOM Monitor] High memory detected (${reason})! Dumping Heap Sampling Profile...`);
			const { profile } = await inspector.sendCommand('HeapProfiler.getSamplingProfile');

			const dumpDir = join(tmpdir(), 'vscode-oom-diagnostics');
			await fs.mkdir(dumpDir, { recursive: true });

			const timestamp = Date.now();
			const prefix = `Renderer-${reason}-${timestamp}`;
			const profilePath = join(dumpDir, `${prefix}-sampling.json`);

			await fs.writeFile(profilePath, JSON.stringify(profile));
			this._logService.warn(`[OOM Monitor] Heap Sampling Profile saved to ${profilePath}`);
			return profilePath;
		} catch (e) {
			this._logService.error('[OOM Monitor] Failed to dump Heap Sampling Profile:', e);
			throw e;
		}
	}

	async stop(): Promise<void> {
		if (!this._isStarted) {
			return;
		}

		const inspector = this._window.webContents.debugger;
		try {
			await inspector.sendCommand('HeapProfiler.stopSampling');
			await inspector.sendCommand('HeapProfiler.disable');
			if (inspector.isAttached()) {
				inspector.detach();
			}
			this._isStarted = false;
		} catch (e) {
			this._logService.error('[OOM Monitor] Failed to stop HeapSamplingProfiler:', e);
		}
	}
}
