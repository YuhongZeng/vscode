/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as net from 'net';
import type { ProfilingSession } from 'v8-inspect-profiler';
import { VSBuffer } from '../../base/common/buffer.js';
import { Emitter, Event } from '../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../base/common/lifecycle.js';
import { FileAccess } from '../../base/common/network.js';
import { delimiter, join, posix } from '../../base/common/path.js';
import { IProcessEnvironment, isWindows } from '../../base/common/platform.js';
import { randomPort } from '../../base/common/ports.js';
import { removeDangerousEnvVariables } from '../../base/common/processes.js';
import { TernarySearchTree } from '../../base/common/ternarySearchTree.js';
import { URI } from '../../base/common/uri.js';
import { findFreePort } from '../../base/node/ports.js';
import { Promises } from '../../base/node/pfs.js';
import { createRandomIPCHandle, NodeSocket, WebSocketNodeSocket } from '../../base/parts/ipc/node/ipc.net.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { ILogService } from '../../platform/log/common/log.js';
import { IV8Profile, IV8ProfileNode } from '../../platform/profiling/common/profiling.js';
import { IRemoteExtensionHostStartParams } from '../../platform/remote/common/remoteAgentConnection.js';
import { getResolvedShellEnv } from '../../platform/shell/node/shellEnv.js';
import { IExtensionHostStatusService } from './extensionHostStatusService.js';
import { getNLSConfiguration } from './remoteLanguagePacks.js';
import { IServerEnvironmentService } from './serverEnvironmentService.js';
import { IPCExtHostConnection, SocketExtHostConnection, writeExtHostConnection } from '../../workbench/services/extensions/common/extensionHostEnv.js';
import { IExtHostReadyMessage, IExtHostReduceGraceTimeMessage, IExtHostSocketMessage } from '../../workbench/services/extensions/common/extensionHostProtocol.js';
import { IRemoteExtensionHostProfileExtension, IRemoteExtensionHostProfileResult, remoteExtensionHostProfileThrottleTime, remoteExtensionHostProfilingDuration, remoteExtensionHostProfilingEnabledSetting } from '../../workbench/services/extensions/common/extensionHostProfiling.js';

const remoteExtensionHostProfileSummaryMaxNodes = 200000;
const remoteExtensionHostProfileSummaryMaxSamples = 500000;
const remoteExtensionHostProfileSummaryMaxFilesPerExtension = 200;
const remoteExtensionHostProfileSummaryTopFilesPerExtension = 50;
const remoteExtensionHostProfileSummaryMaxUnmatchedEntries = 200;
const remoteExtensionHostProfileSummaryMaxIndexedExtensions = 1000;
const remoteExtensionHostProfileSummaryMaxCandidateEntries = 200;
const remoteExtensionHostProfileSummaryMaxExtensionPathLength = 8192;
const remoteExtensionHostProfileSummaryMaxNormalizedUrlCacheEntries = 10000;
const remoteExtensionHostProfileNoFileIndex = -1;
const remoteExtensionHostProfileOtherFilesIndex = -2;

export async function buildUserEnvironment(startParamsEnv: { [key: string]: string | null } = {}, withUserShellEnvironment: boolean, language: string, environmentService: IServerEnvironmentService, logService: ILogService, configurationService: IConfigurationService): Promise<IProcessEnvironment> {
	const nlsConfig = await getNLSConfiguration(language, environmentService.userDataPath);

	let userShellEnv: typeof process.env = {};
	if (withUserShellEnvironment) {
		try {
			userShellEnv = await getResolvedShellEnv(configurationService, logService, environmentService.args, process.env);
		} catch (error) {
			logService.error('ExtensionHostConnection#buildUserEnvironment resolving shell environment failed', error);
		}
	}

	const processEnv = process.env;

	const env: IProcessEnvironment = {
		...processEnv,
		...userShellEnv,
		...{
			VSCODE_ESM_ENTRYPOINT: 'vs/workbench/api/node/extensionHostProcess',
			VSCODE_HANDLES_UNCAUGHT_ERRORS: 'true',
			VSCODE_NLS_CONFIG: JSON.stringify(nlsConfig)
		},
		...startParamsEnv
	};

	const binFolder = environmentService.isBuilt ? join(environmentService.appRoot, 'bin') : join(environmentService.appRoot, 'resources', 'server', 'bin-dev');
	const remoteCliBinFolder = join(binFolder, 'remote-cli'); // contains the `code` command that can talk to the remote server

	let PATH = readCaseInsensitive(env, 'PATH');
	if (PATH) {
		PATH = remoteCliBinFolder + delimiter + PATH;
	} else {
		PATH = remoteCliBinFolder;
	}
	setCaseInsensitive(env, 'PATH', PATH);

	if (!environmentService.args['without-browser-env-var']) {
		env.BROWSER = join(binFolder, 'helpers', isWindows ? 'browser.cmd' : 'browser.sh'); // a command that opens a browser on the local machine
	}

	env.VSCODE_RECONNECTION_GRACE_TIME = String(environmentService.reconnectionGraceTime);
	logService.trace(`[reconnection-grace-time] Setting VSCODE_RECONNECTION_GRACE_TIME env var for extension host: ${environmentService.reconnectionGraceTime}ms (${Math.floor(environmentService.reconnectionGraceTime / 1000)}s)`);

	removeNulls(env);
	return env;
}

class ConnectionData {
	constructor(
		public readonly socket: NodeSocket | WebSocketNodeSocket,
		public readonly initialDataChunk: VSBuffer
	) { }

	public socketDrain(): Promise<void> {
		return this.socket.drain();
	}

	public toIExtHostSocketMessage(): IExtHostSocketMessage {

		let skipWebSocketFrames: boolean;
		let permessageDeflate: boolean;
		let inflateBytes: VSBuffer;

		if (this.socket instanceof NodeSocket) {
			skipWebSocketFrames = true;
			permessageDeflate = false;
			inflateBytes = VSBuffer.alloc(0);
		} else {
			skipWebSocketFrames = false;
			permessageDeflate = this.socket.permessageDeflate;
			inflateBytes = this.socket.recordedInflateBytes;
		}

		return {
			type: 'VSCODE_EXTHOST_IPC_SOCKET',
			initialDataChunk: (<Buffer>this.initialDataChunk.buffer).toString('base64'),
			skipWebSocketFrames: skipWebSocketFrames,
			permessageDeflate: permessageDeflate,
			inflateBytes: (<Buffer>inflateBytes.buffer).toString('base64'),
		};
	}
}

export class ExtensionHostConnection extends Disposable {

	private _onClose = new Emitter<void>();
	readonly onClose: Event<void> = this._onClose.event;

	private readonly _canSendSocket: boolean;
	private _disposed: boolean;
	private _remoteAddress: string;
	private _extensionHostProcess: cp.ChildProcess | null;
	private _connectionData: ConnectionData | null;
	private _extensionHostInspectPort: number | undefined;
	private _extensionHostProfileSession: IRemoteExtensionHostProfileSession | undefined;
	private _extensionHostProfileTimeout: Timeout | undefined;
	private _lastExtensionHostProfileTime: number;

	constructor(
		private readonly _reconnectionToken: string,
		remoteAddress: string,
		socket: NodeSocket | WebSocketNodeSocket,
		initialDataChunk: VSBuffer,
		@IServerEnvironmentService private readonly _environmentService: IServerEnvironmentService,
		@ILogService private readonly _logService: ILogService,
		@IExtensionHostStatusService private readonly _extensionHostStatusService: IExtensionHostStatusService,
		@IConfigurationService private readonly _configurationService: IConfigurationService
	) {
		super();
		this._canSendSocket = (!isWindows || !this._environmentService.args['socket-path']);
		this._disposed = false;
		this._remoteAddress = remoteAddress;
		this._extensionHostProcess = null;
		this._connectionData = new ConnectionData(socket, initialDataChunk);
		this._extensionHostInspectPort = undefined;
		this._extensionHostProfileSession = undefined;
		this._extensionHostProfileTimeout = undefined;
		this._lastExtensionHostProfileTime = 0;

		this._log(`New connection established.`);
	}

	override dispose(): void {
		this._cleanResources();
		super.dispose();
	}

	private get _logPrefix(): string {
		return `[${this._remoteAddress}][${this._reconnectionToken.substr(0, 8)}][ExtensionHostConnection] `;
	}

	private _log(_str: string): void {
		this._logService.info(`${this._logPrefix}${_str}`);
	}

	private _logError(_str: string): void {
		this._logService.error(`${this._logPrefix}${_str}`);
	}

	private async _pipeSockets(extHostSocket: net.Socket, connectionData: ConnectionData): Promise<void> {

		const disposables = new DisposableStore();
		disposables.add(connectionData.socket);
		disposables.add(toDisposable(() => {
			extHostSocket.destroy();
		}));

		const stopAndCleanup = () => {
			disposables.dispose();
		};

		disposables.add(connectionData.socket.onEnd(stopAndCleanup));
		disposables.add(connectionData.socket.onClose(stopAndCleanup));

		disposables.add(Event.fromNodeEventEmitter<void>(extHostSocket, 'end')(stopAndCleanup));
		disposables.add(Event.fromNodeEventEmitter<void>(extHostSocket, 'close')(stopAndCleanup));
		disposables.add(Event.fromNodeEventEmitter<void>(extHostSocket, 'error')(stopAndCleanup));

		disposables.add(connectionData.socket.onData((e) => extHostSocket.write(e.buffer)));
		disposables.add(Event.fromNodeEventEmitter<Buffer>(extHostSocket, 'data')((e) => {
			connectionData.socket.write(VSBuffer.wrap(e));
		}));

		if (connectionData.initialDataChunk.byteLength > 0) {
			extHostSocket.write(connectionData.initialDataChunk.buffer);
		}
	}

	private async _sendSocketToExtensionHost(extensionHostProcess: cp.ChildProcess, connectionData: ConnectionData): Promise<void> {
		// Make sure all outstanding writes have been drained before sending the socket
		await connectionData.socketDrain();
		const msg = connectionData.toIExtHostSocketMessage();
		let socket: net.Socket;
		if (connectionData.socket instanceof NodeSocket) {
			socket = connectionData.socket.socket;
		} else {
			socket = connectionData.socket.socket.socket;
		}
		extensionHostProcess.send(msg, socket);
	}

	public shortenReconnectionGraceTimeIfNecessary(): void {
		if (!this._extensionHostProcess) {
			return;
		}
		const msg: IExtHostReduceGraceTimeMessage = {
			type: 'VSCODE_EXTHOST_IPC_REDUCE_GRACE_TIME'
		};
		this._extensionHostProcess.send(msg);
	}

	public acceptReconnection(remoteAddress: string, _socket: NodeSocket | WebSocketNodeSocket, initialDataChunk: VSBuffer): void {
		this._remoteAddress = remoteAddress;
		this._log(`The client has reconnected.`);
		const connectionData = new ConnectionData(_socket, initialDataChunk);

		if (!this._extensionHostProcess) {
			// The extension host didn't even start up yet
			this._connectionData = connectionData;
			return;
		}

		this._sendSocketToExtensionHost(this._extensionHostProcess, connectionData);
	}

	private _cleanResources(): void {
		if (this._disposed) {
			// already called
			return;
		}
		this._disposed = true;
		this._extensionHostStatusService.removeProfileHandler(this._reconnectionToken);
		this._discardExtensionHostProfileSession();
		if (this._connectionData) {
			this._connectionData.socket.end();
			this._connectionData = null;
		}
		if (this._extensionHostProcess) {
			this._extensionHostProcess.kill();
			this._extensionHostProcess = null;
		}
		this._onClose.fire(undefined);
	}

	private _isRemoteExtensionHostProfilingEnabled(): boolean {
		return this._configurationService.getValue<boolean>(remoteExtensionHostProfilingEnabledSetting) === true;
	}

	private async _findInspectPort(): Promise<number | undefined> {
		const port = await findFreePort(randomPort(), 50, 5000);
		return port || undefined;
	}

	private _clearExtensionHostProfileTimeout(): void {
		if (this._extensionHostProfileTimeout) {
			clearTimeout(this._extensionHostProfileTimeout);
			this._extensionHostProfileTimeout = undefined;
		}
	}

	private _discardExtensionHostProfileSession(): void {
		this._clearExtensionHostProfileTimeout();
		const profileSession = this._extensionHostProfileSession;
		this._extensionHostProfileSession = undefined;
		if (profileSession) {
			void profileSession.session.stop().then(undefined, err => this._logService.error(err));
		}
	}

	public async startExtensionHostProfile(extensions: readonly IRemoteExtensionHostProfileExtension[]): Promise<boolean> {
		if (!this._isRemoteExtensionHostProfilingEnabled()) {
			return false;
		}

		const pid = this._extensionHostProcess?.pid;
		if (!this._extensionHostInspectPort || typeof pid !== 'number') {
			this._log('Remote Extension Host CPU profiling was requested, but no inspect port is available.');
			return false;
		}

		if (this._extensionHostProfileSession) {
			this._log(`<${pid}> Remote Extension Host CPU profiling is already in progress.`);
			return true;
		}

		const now = Date.now();
		if (now - this._lastExtensionHostProfileTime <= remoteExtensionHostProfileThrottleTime) {
			this._log(`<${pid}> Remote Extension Host CPU profiling skipped because it was recently captured.`);
			return false;
		}

		try {
			const profiler = await import('v8-inspect-profiler');
			this._log(`<${pid}> Starting Remote Extension Host CPU profile on 127.0.0.1:${this._extensionHostInspectPort}.`);
			const session = await profiler.startProfiling({ host: '127.0.0.1', port: this._extensionHostInspectPort, checkForPaused: true });
			this._extensionHostProfileSession = { session, extensions, pid };
			this._lastExtensionHostProfileTime = now;
			this._extensionHostProfileTimeout = setTimeout(() => {
				void this._stopExtensionHostProfile('timeout').then(result => {
					if (result) {
						this._log(`<${pid}> Remote Extension Host CPU profile stopped after timeout.`);
					}
				});
			}, remoteExtensionHostProfilingDuration * 2);
			return true;
		} catch (err) {
			this._logError(`<${pid}> Failed to profile Remote Extension Host Process.`);
			this._logService.error(err);
			return false;
		}
	}

	public async stopExtensionHostProfile(): Promise<IRemoteExtensionHostProfileResult | undefined> {
		return this._stopExtensionHostProfile('responsive');
	}

	private async _stopExtensionHostProfile(reason: string): Promise<IRemoteExtensionHostProfileResult | undefined> {
		const profileSession = this._extensionHostProfileSession;
		if (!profileSession) {
			return undefined;
		}

		this._extensionHostProfileSession = undefined;
		this._clearExtensionHostProfileTimeout();
		try {
			this._log(`<${profileSession.pid}> Stopping Remote Extension Host CPU profile (${reason}).`);
			const result = await profileSession.session.stop();
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
			const profilePath = join(this._environmentService.logsHome.fsPath, `exthost-${profileSession.pid}-${timestamp}.cpuprofile`);
			await Promises.writeFile(profilePath, JSON.stringify(result.profile));
			let profileSummary: IRemoteExtensionHostProfileSummary;
			try {
				profileSummary = this._summarizeProfile(result.profile, profileSession.extensions);
			} catch (err) {
				this._logError(`<${profileSession.pid}> Failed to summarize Remote Extension Host CPU profile.`);
				this._logService.error(err);
				profileSummary = createProfileSummary(result.profile, profileSession.extensions, 'summary failed');
			}
			const summaryPath = join(this._environmentService.logsHome.fsPath, `exthost-${profileSession.pid}-${timestamp}.summary.json`);
			await Promises.writeFile(summaryPath, JSON.stringify(profileSummary, undefined, 2));
			this._log(`<${profileSession.pid}> Saved Remote Extension Host CPU profile: ${profilePath}`);
			this._log(`<${profileSession.pid}> Saved Remote Extension Host CPU profile summary: ${summaryPath}`);
			if (profileSummary.skippedReason) {
				this._log(`<${profileSession.pid}> Remote Extension Host CPU profile summary skipped: ${profileSummary.skippedReason}.`);
			} else if (profileSummary.topExtension) {
				this._log(`<${profileSession.pid}> Remote Extension Host CPU profile top extension: ${profileSummary.topExtension.id}, file: ${profileSummary.topExtension.topFile ?? 'unknown'}, entry: ${profileSummary.topExtension.entryPoint ?? 'unknown'}, location: ${profileSummary.topExtension.location}`);
			} else {
				this._log(`<${profileSession.pid}> Remote Extension Host CPU profile did not match samples to a known extension.`);
			}
			return {
				profilePath,
				summaryPath,
				topExtensionId: profileSummary.topExtension?.id,
				topExtensionLocation: profileSummary.topExtension?.location,
				topExtensionEntryPoint: profileSummary.topExtension?.entryPoint,
				topExtensionTotalTime: profileSummary.topExtension?.totalTime,
				topFile: profileSummary.topExtension?.topFile,
				topFileTotalTime: profileSummary.topExtension?.topFileTotalTime
			};
		} catch (err) {
			this._logError(`<${profileSession.pid}> Failed to stop profiling Remote Extension Host Process.`);
			this._logService.error(err);
			return undefined;
		}
	}

	private _summarizeProfile(profile: IV8Profile, extensions: readonly IRemoteExtensionHostProfileExtension[]): IRemoteExtensionHostProfileSummary {
		if (profile.nodes.length > remoteExtensionHostProfileSummaryMaxNodes) {
			return createProfileSummary(profile, extensions, `too many profile nodes (${profile.nodes.length})`);
		}

		const samples = profile.samples ?? [];
		if (samples.length > remoteExtensionHostProfileSummaryMaxSamples) {
			return createProfileSummary(profile, extensions, `too many profile samples (${samples.length})`);
		}

		const timeDeltas = profile.timeDeltas ?? [];
		const extensionProfileIndex = createExtensionProfileIndex(extensions);
		const normalizedExtensions = extensionProfileIndex.extensions;
		const normalizedUrlCache = new Map<string, string>();
		const normalizeUrl = (url: string): string => {
			const cached = normalizedUrlCache.get(url);
			if (typeof cached === 'string') {
				return cached;
			}
			const normalizedUrl = normalizeProfilePath(url);
			if (normalizedUrlCache.size < remoteExtensionHostProfileSummaryMaxNormalizedUrlCacheEntries) {
				normalizedUrlCache.set(url, normalizedUrl);
			}
			return normalizedUrl;
		};
		const nodes = profile.nodes;
		const nodeIndexById = new Map<number, number>();
		for (let i = 0; i < nodes.length; i++) {
			nodeIndexById.set(nodes[i].id, i);
		}

		const nodeExtensionIndexes = new Int32Array(nodes.length);
		const nodeFileIndexes = new Int32Array(nodes.length);
		const nodeSegmentCodes = new Int8Array(nodes.length);
		const visited = new Uint8Array(nodes.length);
		nodeExtensionIndexes.fill(-1);
		nodeFileIndexes.fill(remoteExtensionHostProfileNoFileIndex);

		const fileUrls: string[] = [];
		const fileNormalizedUrls: string[] = [];
		const fileKeyToIndex = new Map<string, number>();
		const fileCountByExtension = new Int32Array(normalizedExtensions.length);
		const getFileIndex = (extensionIndex: number, url: string, normalizedUrl: string): number => {
			const key = `${extensionIndex}:${normalizedUrl}`;
			let index = fileKeyToIndex.get(key);
			if (typeof index === 'number') {
				return index;
			}
			if (fileCountByExtension[extensionIndex] >= remoteExtensionHostProfileSummaryMaxFilesPerExtension) {
				return remoteExtensionHostProfileOtherFilesIndex;
			}
			index = fileUrls.length;
			fileCountByExtension[extensionIndex]++;
			fileKeyToIndex.set(key, index);
			fileUrls.push(url);
			fileNormalizedUrls.push(normalizedUrl);
			return index;
		};

		const stackNodeIndexes: number[] = [];
		const stackExtensionIndexes: number[] = [];
		const stackFileIndexes: number[] = [];
		const stackSegmentCodes: ProfileSegmentCode[] = [];

		const visit = (startIndex: number): void => {
			stackNodeIndexes.push(startIndex);
			stackExtensionIndexes.push(-1);
			stackFileIndexes.push(-1);
			stackSegmentCodes.push(ProfileSegmentCode.None);

			while (stackNodeIndexes.length > 0) {
				const nodeIndex = stackNodeIndexes.pop()!;
				let extensionIndex = stackExtensionIndexes.pop()!;
				let fileIndex = stackFileIndexes.pop()!;
				let segmentCode = stackSegmentCodes.pop()!;
				if (visited[nodeIndex]) {
					continue;
				}
				visited[nodeIndex] = 1;

				const node = nodes[nodeIndex];
				const matchedFrame = matchExtensionFrame(node.callFrame.url, extensionProfileIndex.extensionPathTree, normalizeUrl);
				if (matchedFrame) {
					extensionIndex = matchedFrame.extensionIndex;
					fileIndex = getFileIndex(extensionIndex, matchedFrame.url, matchedFrame.normalizedUrl);
					segmentCode = ProfileSegmentCode.None;
				} else if (extensionIndex < 0 && segmentCode === ProfileSegmentCode.None) {
					segmentCode = getProfileSegmentCode(node);
				}

				nodeExtensionIndexes[nodeIndex] = extensionIndex;
				nodeFileIndexes[nodeIndex] = fileIndex;
				nodeSegmentCodes[nodeIndex] = segmentCode;

				for (const child of node.children ?? []) {
					const childIndex = nodeIndexById.get(child);
					if (typeof childIndex === 'number' && !visited[childIndex]) {
						stackNodeIndexes.push(childIndex);
						stackExtensionIndexes.push(extensionIndex);
						stackFileIndexes.push(fileIndex);
						stackSegmentCodes.push(segmentCode);
					}
				}
			}
		};

		if (nodes.length > 0) {
			visit(0);
		}
		for (let i = 0; i < nodes.length; i++) {
			if (!visited[i]) {
				visit(i);
			}
		}

		const extensionTotalTimes = new Float64Array(normalizedExtensions.length);
		const extensionFileTotals = new Map<number, Map<number, number>>();
		const unmatched = new Map<string, number>();
		for (let i = 0; i < samples.length; i++) {
			const nodeIndex = nodeIndexById.get(samples[i]);
			const node = typeof nodeIndex === 'number' ? nodes[nodeIndex] : undefined;
			const url = node?.callFrame.url;
			const time = timeDeltas[i] ?? 0;
			if (time <= 0) {
				continue;
			}

			if (typeof nodeIndex !== 'number') {
				addCappedTotal(unmatched, '(missing node)', time, remoteExtensionHostProfileSummaryMaxUnmatchedEntries, '(other unmatched)');
				continue;
			}

			const extensionIndex = nodeExtensionIndexes[nodeIndex];
			if (extensionIndex < 0) {
				const unmatchedUrl = url || getProfileSegmentName(nodeSegmentCodes[nodeIndex]) || '(anonymous)';
				addCappedTotal(unmatched, unmatchedUrl, time, remoteExtensionHostProfileSummaryMaxUnmatchedEntries, '(other unmatched)');
				continue;
			}

			extensionTotalTimes[extensionIndex] += time;
			const fileIndex = nodeFileIndexes[nodeIndex];
			if (fileIndex !== remoteExtensionHostProfileNoFileIndex) {
				let files = extensionFileTotals.get(extensionIndex);
				if (!files) {
					files = new Map<number, number>();
					extensionFileTotals.set(extensionIndex, files);
				}
				addCappedTotal(files, fileIndex, time, remoteExtensionHostProfileSummaryMaxFilesPerExtension, remoteExtensionHostProfileOtherFilesIndex);
			}
		}

		const extensionSummaries: IRemoteExtensionHostProfileExtensionSummary[] = [];
		for (let extensionIndex = 0; extensionIndex < normalizedExtensions.length; extensionIndex++) {
			const totalTime = extensionTotalTimes[extensionIndex];
			if (totalTime <= 0) {
				continue;
			}
			const extension = normalizedExtensions[extensionIndex];
			const files = [...(extensionFileTotals.get(extensionIndex)?.entries() ?? [])]
				.map(([fileIndex, totalTime]) => fileIndex === remoteExtensionHostProfileOtherFilesIndex
					? { url: '(other extension files)', normalizedUrl: '(other)', totalTime }
					: { url: fileUrls[fileIndex], normalizedUrl: fileNormalizedUrls[fileIndex], totalTime }
				)
				.sort((a, b) => b.totalTime - a.totalTime)
				.slice(0, remoteExtensionHostProfileSummaryTopFilesPerExtension);
			extensionSummaries.push({
				id: extension.id,
				location: extension.location,
				main: extension.main,
				entryPoint: extension.entryPoint,
				normalizedLocation: extension.normalizedLocation,
				normalizedEntryPoint: extension.normalizedEntryPoint,
				totalTime,
				topFile: files[0]?.url,
				topFileTotalTime: files[0]?.totalTime,
				files
			});
		}
		extensionSummaries.sort((a, b) => b.totalTime - a.totalTime);
		return {
			nodeCount: nodes.length,
			sampleCount: samples.length,
			extensionCandidateCount: extensions.length,
			extensionCandidates: extensionProfileIndex.extensionCandidates,
			extensions: extensionSummaries,
			topExtension: extensionSummaries[0],
			unmatched: [...unmatched.entries()]
				.map(([url, totalTime]) => ({ url, normalizedUrl: normalizeProfilePath(url), totalTime }))
				.sort((a, b) => b.totalTime - a.totalTime)
				.slice(0, 50)
		};
	}

	public async start(startParams: IRemoteExtensionHostStartParams): Promise<void> {
		try {
			let execArgv: string[] = process.execArgv ? process.execArgv.filter(a => !/^--inspect(-brk)?=/.test(a)) : [];
			const enableRemoteExtensionHostProfiling = this._isRemoteExtensionHostProfilingEnabled() && typeof startParams.port !== 'number';
			// eslint-disable-next-line local/code-no-any-casts, @typescript-eslint/no-explicit-any
			if (startParams.port && !(<any>process).pkg) {
				execArgv = [
					`--inspect${startParams.break ? '-brk' : ''}=${startParams.port}`,
					'--experimental-network-inspection'
				];
			} else if (enableRemoteExtensionHostProfiling && !(<any>process).pkg) {
				this._extensionHostInspectPort = await this._findInspectPort();
				if (this._extensionHostInspectPort) {
					execArgv.unshift(`--inspect=127.0.0.1:${this._extensionHostInspectPort}`);
				} else {
					this._log('Could not find a free inspect port for remote extension host CPU profiling.');
				}
			}

			const env = await buildUserEnvironment(startParams.env, true, startParams.language, this._environmentService, this._logService, this._configurationService);
			removeDangerousEnvVariables(env);

			let extHostNamedPipeServer: net.Server | null;

			if (this._canSendSocket) {
				writeExtHostConnection(new SocketExtHostConnection(), env);
				extHostNamedPipeServer = null;
			} else {
				const { namedPipeServer, pipeName } = await this._listenOnPipe();
				writeExtHostConnection(new IPCExtHostConnection(pipeName), env);
				extHostNamedPipeServer = namedPipeServer;
			}

			const opts = {
				env,
				execArgv,
				silent: true
			};

			// Refs https://github.com/microsoft/vscode/issues/189805
			opts.execArgv.unshift('--dns-result-order=ipv4first');

			// Run Extension Host as fork of current process
			const args = ['--type=extensionHost', `--transformURIs`];
			const useHostProxy = this._environmentService.args['use-host-proxy'];
			args.push(`--useHostProxy=${useHostProxy ? 'true' : 'false'}`);
			if (this._configurationService.getValue<boolean>('extensions.supportNodeGlobalNavigator')) {
				args.push('--supportGlobalNavigator');
			}
			this._extensionHostProcess = cp.fork(FileAccess.asFileUri('bootstrap-fork').fsPath, args, opts);
			const pid = this._extensionHostProcess.pid;
			this._log(`<${pid}> Launched Extension Host Process.`);
			if (enableRemoteExtensionHostProfiling && this._extensionHostInspectPort && typeof pid === 'number') {
				this._log(`<${pid}> Remote Extension Host CPU profiling enabled on 127.0.0.1:${this._extensionHostInspectPort}.`);
				this._extensionHostStatusService.setProfileHandler(this._reconnectionToken, {
					start: extensions => this.startExtensionHostProfile(extensions),
					stop: () => this.stopExtensionHostProfile()
				});
			}

			// Catch all output coming from the extension host process
			this._extensionHostProcess.stdout!.setEncoding('utf8');
			this._extensionHostProcess.stderr!.setEncoding('utf8');
			const onStdout = Event.fromNodeEventEmitter<string>(this._extensionHostProcess.stdout!, 'data');
			const onStderr = Event.fromNodeEventEmitter<string>(this._extensionHostProcess.stderr!, 'data');
			this._register(onStdout((e) => this._log(`<${pid}> ${e}`)));
			this._register(onStderr((e) => this._log(`<${pid}><stderr> ${e}`)));

			// Lifecycle
			this._extensionHostProcess.on('error', (err) => {
				this._logError(`<${pid}> Extension Host Process had an error`);
				this._logService.error(err);
				this._cleanResources();
			});

			this._extensionHostProcess.on('exit', (code: number, signal: string) => {
				this._extensionHostStatusService.setExitInfo(this._reconnectionToken, { code, signal });
				this._log(`<${pid}> Extension Host Process exited with code: ${code}, signal: ${signal}.`);
				this._cleanResources();
			});

			if (extHostNamedPipeServer) {
				extHostNamedPipeServer.on('connection', (socket) => {
					extHostNamedPipeServer.close();
					this._pipeSockets(socket, this._connectionData!);
				});
			} else {
				const messageListener = (msg: IExtHostReadyMessage) => {
					if (msg.type === 'VSCODE_EXTHOST_IPC_READY') {
						this._extensionHostProcess!.removeListener('message', messageListener);
						this._sendSocketToExtensionHost(this._extensionHostProcess!, this._connectionData!);
						this._connectionData = null;
					}
				};
				this._extensionHostProcess.on('message', messageListener);
			}

		} catch (error) {
			console.error('ExtensionHostConnection errored');
			if (error) {
				console.error(error);
			}
		}
	}

	private _listenOnPipe(): Promise<{ pipeName: string; namedPipeServer: net.Server }> {
		return new Promise<{ pipeName: string; namedPipeServer: net.Server }>((resolve, reject) => {
			const pipeName = createRandomIPCHandle();

			const namedPipeServer = net.createServer();
			namedPipeServer.on('error', reject);
			namedPipeServer.listen(pipeName, () => {
				namedPipeServer?.removeListener('error', reject);
				resolve({ pipeName, namedPipeServer });
			});
		});
	}
}

function readCaseInsensitive(env: { [key: string]: string | undefined }, key: string): string | undefined {
	const pathKeys = Object.keys(env).filter(k => k.toLowerCase() === key.toLowerCase());
	const pathKey = pathKeys.length > 0 ? pathKeys[0] : key;
	return env[pathKey];
}

function setCaseInsensitive(env: { [key: string]: unknown }, key: string, value: string): void {
	const pathKeys = Object.keys(env).filter(k => k.toLowerCase() === key.toLowerCase());
	const pathKey = pathKeys.length > 0 ? pathKeys[0] : key;
	env[pathKey] = value;
}

function removeNulls(env: { [key: string]: unknown | null }): void {
	// Don't delete while iterating the object itself
	for (const key of Object.keys(env)) {
		if (env[key] === null) {
			delete env[key];
		}
	}
}

interface IRemoteExtensionHostProfileSummary {
	readonly nodeCount: number;
	readonly sampleCount: number;
	readonly skippedReason?: string;
	readonly extensionCandidateCount?: number;
	readonly extensionCandidates: IRemoteExtensionHostProfileNormalizedExtension[];
	readonly extensions: IRemoteExtensionHostProfileExtensionSummary[];
	readonly topExtension: IRemoteExtensionHostProfileExtensionSummary | undefined;
	readonly unmatched: IRemoteExtensionHostProfileFileSummary[];
}

interface IRemoteExtensionHostProfileExtensionSummary {
	readonly id: string;
	readonly location: string;
	readonly main: string | undefined;
	readonly entryPoint: string | undefined;
	readonly normalizedLocation: string;
	readonly normalizedEntryPoint: string | undefined;
	totalTime: number;
	topFile: string | undefined;
	topFileTotalTime: number | undefined;
	readonly files: IRemoteExtensionHostProfileFileSummary[];
}

interface IRemoteExtensionHostProfileFileSummary {
	readonly url: string;
	readonly normalizedUrl: string;
	totalTime: number;
}

interface IRemoteExtensionHostProfileNormalizedExtension {
	readonly id: string;
	readonly location: string;
	readonly main: string | undefined;
	readonly entryPoint: string | undefined;
	readonly normalizedLocation: string;
	readonly normalizedEntryPoint: string | undefined;
}

interface IRemoteExtensionHostProfileIndex {
	readonly extensions: IRemoteExtensionHostProfileNormalizedExtension[];
	readonly extensionCandidates: IRemoteExtensionHostProfileNormalizedExtension[];
	readonly extensionPathTree: TernarySearchTree<string, number>;
}

type ProfileSegmentId = 'program' | 'gc' | 'self';

interface IRemoteExtensionHostProfileMatchedFrame {
	readonly extensionIndex: number;
	readonly url: string;
	readonly normalizedUrl: string;
}

interface IRemoteExtensionHostProfileSession {
	readonly session: ProfilingSession;
	readonly extensions: readonly IRemoteExtensionHostProfileExtension[];
	readonly pid: number;
}

const enum ProfileSegmentCode {
	None = 0,
	Program = 1,
	GC = 2,
	Self = 3
}

function createProfileSummary(profile: IV8Profile, extensions: readonly IRemoteExtensionHostProfileExtension[], skippedReason: string): IRemoteExtensionHostProfileSummary {
	return {
		nodeCount: profile.nodes.length,
		sampleCount: profile.samples?.length ?? 0,
		skippedReason,
		extensionCandidateCount: extensions.length,
		extensionCandidates: [],
		extensions: [],
		topExtension: undefined,
		unmatched: []
	};
}

function createExtensionProfileIndex(extensions: readonly IRemoteExtensionHostProfileExtension[]): IRemoteExtensionHostProfileIndex {
	const indexedExtensions: IRemoteExtensionHostProfileNormalizedExtension[] = [];
	const extensionCandidates: IRemoteExtensionHostProfileNormalizedExtension[] = [];
	const extensionPathTree = TernarySearchTree.forPaths<number>(isWindows);
	for (const extension of extensions) {
		if (indexedExtensions.length >= remoteExtensionHostProfileSummaryMaxIndexedExtensions) {
			break;
		}
		const normalizedExtension = normalizeProfileExtension(extension);
		if (!normalizedExtension) {
			continue;
		}
		const index = indexedExtensions.length;
		indexedExtensions.push(normalizedExtension);
		extensionPathTree.set(normalizedExtension.normalizedLocation, index + 1);
		if (extensionCandidates.length < remoteExtensionHostProfileSummaryMaxCandidateEntries) {
			extensionCandidates.push(normalizedExtension);
		}
	}
	return {
		extensions: indexedExtensions,
		extensionCandidates,
		extensionPathTree
	};
}

function normalizeProfileExtension(extension: IRemoteExtensionHostProfileExtension): IRemoteExtensionHostProfileNormalizedExtension | undefined {
	const id = toProfileString(extension.id);
	const location = toProfileString(extension.location);
	const main = toProfileString(extension.main);
	if (!id || !location) {
		return undefined;
	}
	const entryPoint = main ? joinProfilePaths(location, main) : undefined;
	const normalizedLocation = normalizeProfilePath(location);
	if (!normalizedLocation) {
		return undefined;
	}
	return {
		id,
		location,
		main,
		entryPoint,
		normalizedLocation,
		normalizedEntryPoint: entryPoint ? normalizeProfilePath(entryPoint) : undefined
	};
}

function toProfileString(value: string | undefined): string | undefined {
	if (typeof value !== 'string' || value.length === 0 || value.length > remoteExtensionHostProfileSummaryMaxExtensionPathLength) {
		return undefined;
	}
	return value;
}

function joinProfilePaths(parent: string, child: string): string {
	if (/^\w[\w\d+.-]*:/.test(child)) {
		return child;
	}
	return posix.join(parent.replace(/\\/g, '/'), child.replace(/\\/g, '/'));
}

function matchExtensionFrame(url: string | undefined, extensionPathTree: TernarySearchTree<string, number>, normalizeUrl: (url: string) => string): IRemoteExtensionHostProfileMatchedFrame | undefined {
	if (!url) {
		return undefined;
	}

	const normalizedUrl = normalizeUrl(url);
	if (!normalizedUrl) {
		return undefined;
	}

	const extensionIndex = extensionPathTree.findSubstr(normalizedUrl);
	if (typeof extensionIndex === 'number') {
		return {
			extensionIndex: extensionIndex - 1,
			url,
			normalizedUrl
		};
	}

	return undefined;
}

function getProfileSegmentCode(node: IV8ProfileNode): ProfileSegmentCode {
	switch (node.callFrame.functionName) {
		case '(root)':
			return ProfileSegmentCode.None;
		case '(program)':
			return ProfileSegmentCode.Program;
		case '(garbage collector)':
			return ProfileSegmentCode.GC;
		default:
			return ProfileSegmentCode.Self;
	}
}

function getProfileSegmentName(segmentCode: ProfileSegmentCode): ProfileSegmentId | undefined {
	switch (segmentCode) {
		case ProfileSegmentCode.Program:
			return 'program';
		case ProfileSegmentCode.GC:
			return 'gc';
		case ProfileSegmentCode.Self:
			return 'self';
		default:
			return undefined;
	}
}

function normalizeProfilePath(value: string): string {
	try {
		const url = URI.parse(value);
		if (url.scheme === 'file' || url.scheme === 'vscode-remote') {
			return normalizeProfilePath(url.path);
		}
	} catch {
		// ignore
	}
	const normalizedPath = value.replace(/\\/g, '/').replace(/^\/([a-zA-Z]:\/)/, '$1').replace(/\/+$/g, '');
	return isWindows ? normalizedPath.toLowerCase() : normalizedPath;
}

function addCappedTotal<TKey>(map: Map<TKey, number>, key: TKey, value: number, limit: number, overflowKey: TKey): void {
	if (map.has(key) || map.size < limit) {
		map.set(key, (map.get(key) ?? 0) + value);
	} else {
		map.set(overflowKey, (map.get(overflowKey) ?? 0) + value);
	}
}
