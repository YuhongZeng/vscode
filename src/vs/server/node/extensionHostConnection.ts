/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as net from 'net';
import { VSBuffer } from '../../base/common/buffer.js';
import { Emitter, Event } from '../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../base/common/lifecycle.js';
import { FileAccess } from '../../base/common/network.js';
import { delimiter, join, posix } from '../../base/common/path.js';
import { IProcessEnvironment, isWindows } from '../../base/common/platform.js';
import { randomPort } from '../../base/common/ports.js';
import { removeDangerousEnvVariables } from '../../base/common/processes.js';
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
	private _extensionHostProfileInProgress: boolean;
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
		this._extensionHostProfileInProgress = false;
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

	public async profileExtensionHost(extensions: readonly IRemoteExtensionHostProfileExtension[]): Promise<IRemoteExtensionHostProfileResult | undefined> {
		if (!this._isRemoteExtensionHostProfilingEnabled()) {
			return undefined;
		}

		const pid = this._extensionHostProcess?.pid;
		if (!this._extensionHostInspectPort || typeof pid !== 'number') {
			this._log('Remote Extension Host CPU profiling was requested, but no inspect port is available.');
			return undefined;
		}

		if (this._extensionHostProfileInProgress) {
			this._log(`<${pid}> Remote Extension Host CPU profiling is already in progress.`);
			return undefined;
		}

		const now = Date.now();
		if (now - this._lastExtensionHostProfileTime <= remoteExtensionHostProfileThrottleTime) {
			this._log(`<${pid}> Remote Extension Host CPU profiling skipped because it was recently captured.`);
			return undefined;
		}

		this._extensionHostProfileInProgress = true;
		this._lastExtensionHostProfileTime = now;
		let session: import('v8-inspect-profiler').ProfilingSession | undefined;
		try {
			const profiler = await import('v8-inspect-profiler');
			this._log(`<${pid}> Starting Remote Extension Host CPU profile on 127.0.0.1:${this._extensionHostInspectPort}.`);
			session = await profiler.startProfiling({ host: '127.0.0.1', port: this._extensionHostInspectPort, checkForPaused: true });
			await new Promise(resolve => setTimeout(resolve, remoteExtensionHostProfilingDuration));
			const result = await session.stop();
			session = undefined;

			const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
			const profilePath = join(this._environmentService.logsHome.fsPath, `exthost-${pid}-${timestamp}.cpuprofile`);
			await Promises.writeFile(profilePath, JSON.stringify(result.profile));
			const profileSummary = this._summarizeProfile(result.profile, extensions);
			const summaryPath = join(this._environmentService.logsHome.fsPath, `exthost-${pid}-${timestamp}.summary.json`);
			await Promises.writeFile(summaryPath, JSON.stringify(profileSummary, undefined, 2));
			this._log(`<${pid}> Saved Remote Extension Host CPU profile: ${profilePath}`);
			this._log(`<${pid}> Saved Remote Extension Host CPU profile summary: ${summaryPath}`);
			if (profileSummary.topExtension) {
				this._log(`<${pid}> Remote Extension Host CPU profile top extension: ${profileSummary.topExtension.id}, file: ${profileSummary.topExtension.topFile ?? 'unknown'}, entry: ${profileSummary.topExtension.entryPoint ?? 'unknown'}, location: ${profileSummary.topExtension.location}`);
			} else {
				this._log(`<${pid}> Remote Extension Host CPU profile did not match samples to a known extension.`);
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
			try {
				await session?.stop();
			} catch {
				// ignore
			}
			this._logError(`<${pid}> Failed to profile Remote Extension Host Process.`);
			this._logService.error(err);
			return undefined;
		} finally {
			this._extensionHostProfileInProgress = false;
		}
	}

	private _summarizeProfile(profile: IV8Profile, extensions: readonly IRemoteExtensionHostProfileExtension[]): IRemoteExtensionHostProfileSummary {
		const normalizedExtensions = extensions
			.map(extension => {
				const entryPoint = extension.main ? joinProfilePaths(extension.location, extension.main) : undefined;
				return {
					id: extension.id,
					location: extension.location,
					main: extension.main,
					entryPoint,
					normalizedLocation: normalizeProfilePath(extension.location),
					normalizedEntryPoint: entryPoint ? normalizeProfilePath(entryPoint) : undefined
				};
			})
			.filter(extension => extension.normalizedLocation.length > 0)
			.sort((a, b) => b.normalizedLocation.length - a.normalizedLocation.length);
		const nodesById = new Map<number, IV8ProfileNode>();
		const childIds = new Set<number>();
		for (const node of profile.nodes) {
			nodesById.set(node.id, node);
			for (const child of node.children ?? []) {
				childIds.add(child);
			}
		}

		const extensionFrameByNodeId = new Map<number, IRemoteExtensionHostProfileMatchedFrame | undefined>();
		const roots = profile.nodes.filter(node => !childIds.has(node.id));
		if (roots.length === 0 && profile.nodes[0]) {
			roots.push(profile.nodes[0]);
		}

		const stack = roots.map(node => ({ node, inherited: undefined as IRemoteExtensionHostProfileMatchedFrame | undefined }));
		while (stack.length > 0) {
			const { node, inherited } = stack.pop()!;
			const matchedFrame = matchExtensionFrame(node.callFrame.url, normalizedExtensions) ?? inherited;
			extensionFrameByNodeId.set(node.id, matchedFrame);
			for (const child of node.children ?? []) {
				const childNode = nodesById.get(child);
				if (childNode) {
					stack.push({ node: childNode, inherited: matchedFrame });
				}
			}
		}
		for (const node of profile.nodes) {
			if (!extensionFrameByNodeId.has(node.id)) {
				extensionFrameByNodeId.set(node.id, matchExtensionFrame(node.callFrame.url, normalizedExtensions));
			}
		}

		const extensionTotals = new Map<string, IRemoteExtensionHostProfileExtensionSummary>();
		const extensionFileTotals = new Map<string, Map<string, IRemoteExtensionHostProfileFileSummary>>();
		const unmatched = new Map<string, number>();
		const samples = profile.samples ?? [];
		const timeDeltas = profile.timeDeltas ?? [];
		for (let i = 0; i < samples.length; i++) {
			const node = nodesById.get(samples[i]);
			const url = node?.callFrame.url;
			const time = timeDeltas[i] ?? 0;
			if (time <= 0) {
				continue;
			}

			const matchedFrame = node ? extensionFrameByNodeId.get(node.id) : undefined;
			if (!matchedFrame) {
				const unmatchedUrl = url || '(anonymous)';
				unmatched.set(unmatchedUrl, (unmatched.get(unmatchedUrl) ?? 0) + time);
				continue;
			}

			let summary = extensionTotals.get(matchedFrame.extension.id);
			if (!summary) {
				summary = {
					id: matchedFrame.extension.id,
					location: matchedFrame.extension.location,
					main: matchedFrame.extension.main,
					entryPoint: matchedFrame.extension.entryPoint,
					normalizedLocation: matchedFrame.extension.normalizedLocation,
					normalizedEntryPoint: matchedFrame.extension.normalizedEntryPoint,
					totalTime: 0,
					topFile: undefined,
					topFileTotalTime: undefined,
					files: []
				};
				extensionTotals.set(matchedFrame.extension.id, summary);
				extensionFileTotals.set(matchedFrame.extension.id, new Map<string, IRemoteExtensionHostProfileFileSummary>());
			}
			summary.totalTime += time;

			const files = extensionFileTotals.get(matchedFrame.extension.id)!;
			const fileKey = matchedFrame.normalizedUrl;
			const file = files.get(fileKey);
			if (file) {
				file.totalTime += time;
			} else {
				const newFile = { url: matchedFrame.url, normalizedUrl: matchedFrame.normalizedUrl, totalTime: time };
				files.set(fileKey, newFile);
				summary.files.push(newFile);
			}
		}

		const extensionSummaries = [...extensionTotals.values()]
			.map(summary => {
				summary.files.sort((a, b) => b.totalTime - a.totalTime);
				summary.topFile = summary.files[0]?.url;
				summary.topFileTotalTime = summary.files[0]?.totalTime;
				return summary;
			})
			.sort((a, b) => b.totalTime - a.totalTime);
		return {
			extensionCandidates: normalizedExtensions,
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
				this._extensionHostStatusService.setProfileHandler(this._reconnectionToken, extensions => this.profileExtensionHost(extensions));
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
					if (msg?.type === 'VSCODE_EXTHOST_IPC_READY') {
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

interface IRemoteExtensionHostProfileMatchedFrame {
	readonly extension: IRemoteExtensionHostProfileNormalizedExtension;
	readonly url: string;
	readonly normalizedUrl: string;
}

function joinProfilePaths(parent: string, child: string): string {
	if (/^\w[\w\d+.-]*:/.test(child)) {
		return child;
	}
	return posix.join(parent.replace(/\\/g, '/'), child.replace(/\\/g, '/'));
}

function matchExtensionFrame(url: string | undefined, extensions: readonly IRemoteExtensionHostProfileNormalizedExtension[]): IRemoteExtensionHostProfileMatchedFrame | undefined {
	if (!url) {
		return undefined;
	}

	const normalizedUrl = normalizeProfilePath(url);
	if (!normalizedUrl) {
		return undefined;
	}

	const extension = extensions.find(candidate => isEqualOrParentProfilePath(normalizedUrl, candidate.normalizedLocation));
	if (!extension) {
		return undefined;
	}

	return {
		extension,
		url,
		normalizedUrl
	};
}

function normalizeProfilePath(value: string): string {
	try {
		const url = new URL(value);
		if (url.protocol === 'file:' || url.protocol === 'vscode-remote:') {
			return normalizeProfilePath(decodeURIComponent(url.pathname));
		}
	} catch {
		// ignore
	}
	return value.replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
}

function isEqualOrParentProfilePath(candidate: string, parent: string): boolean {
	return candidate === parent || candidate.startsWith(`${parent}/`);
}
