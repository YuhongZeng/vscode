/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as v8 from 'v8';
import { createRequire } from 'node:module';
import { OOMDiagnosticMonitor as CommonMonitor } from '../common/oomDiagnostics.js';

interface IPProfModule {
	heap: {
		start(intervalBytes: number, stackDepth: number): void;
		profile(): Promise<unknown>;
	};
	encode(profile: unknown): Promise<Buffer>;
}

let pprof: IPProfModule | null = null;

try {
	// pprof is an optional native C++ add-on, dynamically require it to avoid crashing in environments where it's not installed
	// eslint-disable-next-line
	const nodeRequire = typeof require === 'function' ? require : createRequire(import.meta.url);
	pprof = nodeRequire('pprof') as IPProfModule;
} catch (e) {
	// Ignore load failures
}

// ---------------------------------------------------------
// 2. Node.js Specific Diagnostic Monitor
// ---------------------------------------------------------
export class NodeOOMDiagnosticMonitor extends CommonMonitor {
	private dumpLock: Promise<void> | null = null;
	private isSampling = false;
	private dumpDir: string = '';

	// Threshold configuration
	private checkIntervalMs = 5000; // Poll every 5 seconds
	private thresholdRatio = 0.8;   // 80% of heap limit
	private lastDumpedRatio = 0;    // Record memory ratio of the last dump
	private dumpGrowthThresholdRatio = 0.05; // Memory must grow by 5% (e.g. from 80% to 85%) to dump again

	constructor() {
		super();
		this.dumpDir = path.join(os.tmpdir(), 'vscode-oom-diagnostics');
		if (!fs.existsSync(this.dumpDir)) {
			fs.mkdirSync(this.dumpDir, { recursive: true });
		}
	}

	/**
	 * Start low-overhead heap allocation sampling and memory monitoring
	 */
	public override startMonitoring(processName: string = 'unknown') {
		if (!pprof) {
			console.warn('[OOM Monitor] pprof module not available. Monitoring disabled.');
			return;
		}

		if (this.isSampling) {
			return;
		}

		// Start pprof heap allocation sampling
		// intervalBytes: sample once per 512KB allocated (default, very low overhead)
		// stackDepth: keep 64 frames of call stack
		try {
			pprof.heap.start(512 * 1024, 64);
			this.isSampling = true;
			this.recordEvent('SYSTEM', 'MONITOR_STARTED', 0, processName);
			console.log(`[OOM Monitor] Started allocation sampling for ${processName}`);
		} catch (err) {
			console.error('[OOM Monitor] Failed to start pprof:', err);
			return;
		}

		// Start low frequency polling
		setInterval(async () => {
			await this.checkMemory(processName);
		}, this.checkIntervalMs);
	}

	private async checkMemory(processName: string) {
		if (this.dumpLock || !this.isSampling) {
			return;
		}

		const stats = v8.getHeapStatistics();
		const ratio = stats.used_heap_size / stats.heap_size_limit;

		// If over 80% and has grown by at least 5% since last dump
		if (ratio > this.thresholdRatio && (ratio > this.lastDumpedRatio + this.dumpGrowthThresholdRatio)) {
			// Use Promise lock to intercept concurrent calls
			if (this.dumpLock) {
				return;
			}

			this.dumpLock = (async () => {
				this.recordEvent('SYSTEM', 'OOM_THRESHOLD_REACHED', stats.used_heap_size, `Ratio: ${(ratio * 100).toFixed(2)}%`);

				try {
					await this.generateDiagnosticDump(processName);
					this.lastDumpedRatio = ratio; // Update high watermark after successful dump
				} catch (err) {
					console.error('[OOM Monitor] Diagnostic dump failed:', err);
				} finally {
					// 10s cooldown allows catching fast-growing leaks while preventing same-watermark flapping
					setTimeout(() => { this.dumpLock = null; }, 10000);
				}
			})();

			await this.dumpLock;
		}
	}

	private async generateDiagnosticDump(processName: string) {
		if (!pprof) {
			return;
		}
		const timestamp = Date.now();
		const prefix = `${processName}-${timestamp}`;

		console.warn(`[OOM Monitor] High memory detected! Generating low-overhead profile for ${processName}...`);

		// 1. Get and save pprof sampling profile
		// This only reads already recorded data, very fast and non-blocking
		const profile = await pprof.heap.profile();
		const profileBuf = await pprof.encode(profile);
		const profilePath = path.join(this.dumpDir, `${prefix}-alloc.pb.gz`);
		fs.writeFileSync(profilePath, profileBuf);

		// 2. Save Ring Buffer blackbox
		const breadcrumbsPath = path.join(this.dumpDir, `${prefix}-breadcrumbs.json`);
		fs.writeFileSync(breadcrumbsPath, JSON.stringify(this.breadcrumbs.toArray(), null, 2));

		console.warn(`[OOM Monitor] Diagnostics saved to ${this.dumpDir}`);
	}
}

// Auto-register singleton to ensure CommonMonitor.getInstance() gets this enhanced version in Node
CommonMonitor.setInstance(new NodeOOMDiagnosticMonitor());
