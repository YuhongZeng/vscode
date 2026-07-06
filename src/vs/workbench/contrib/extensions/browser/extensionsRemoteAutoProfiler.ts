/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ExtensionHostKind } from '../../../services/extensions/common/extensionHostKind.js';
import { IRemoteExtensionHostProfileResult, remoteExtensionHostProfilingDuration, remoteExtensionHostProfilingEnabledSetting } from '../../../services/extensions/common/extensionHostProfiling.js';
import { IExtensionService, IResponsiveStateChangeEvent } from '../../../services/extensions/common/extensions.js';
import { IRemoteAgentService } from '../../../services/remote/common/remoteAgentService.js';

export class ExtensionsRemoteAutoProfiler extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.extensionsRemoteAutoProfiler';

	private readonly _sessions = new Map<string, IRemoteExtensionHostProfileSession>();

	constructor(
		@IExtensionService extensionService: IExtensionService,
		@IRemoteAgentService private readonly _remoteAgentService: IRemoteAgentService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService
	) {
		super();
		this._register(extensionService.onDidChangeResponsiveChange(this._onDidChangeResponsiveChange, this));
	}

	override dispose(): void {
		for (const session of this._sessions.values()) {
			session.cts.dispose(true);
		}
		this._sessions.clear();
		super.dispose();
	}

	private async _onDidChangeResponsiveChange(event: IResponsiveStateChangeEvent): Promise<void> {
		if (event.extensionHostKind !== ExtensionHostKind.Remote) {
			return;
		}
		if (this._configurationService.getValue<boolean>(remoteExtensionHostProfilingEnabledSetting) !== true) {
			return;
		}
		if (!event.remoteConnectionToken) {
			this._logService.warn('UNRESPONSIVE remote extension host: cannot profile because there is no remote connection token.');
			return;
		}

		const currentSession = this._sessions.get(event.remoteConnectionToken);
		if (event.isResponsive && currentSession) {
			currentSession.cts.cancel();
			this._logService.info('UNRESPONSIVE remote extension host: received responsive event and cancelling profiling session');

		} else if (!event.isResponsive && !currentSession) {
			const session: IRemoteExtensionHostProfileSession = { cts: new CancellationTokenSource() };
			this._sessions.set(event.remoteConnectionToken, session);

			let started = false;
			try {
				started = await this._remoteAgentService.startExtensionHostProfile(event.remoteConnectionToken);
			} catch (err) {
				this._deleteSession(event.remoteConnectionToken, session);
				this._logService.error('UNRESPONSIVE remote extension host: failed to start CPU profile.');
				this._logService.error(err);
				return;
			}

			if (!started) {
				this._deleteSession(event.remoteConnectionToken, session);
				return;
			}

			this._logService.info('UNRESPONSIVE remote extension host: starting to profile NOW');
			try {
				await timeout(remoteExtensionHostProfilingDuration, session.cts.token);
			} catch {
				// Can throw cancellation error. That is OK, we stop profiling and save the profile if it is long enough.
			}

			try {
				this._logProfileResult(await this._remoteAgentService.stopExtensionHostProfile(event.remoteConnectionToken));
			} catch (err) {
				onUnexpectedError(err);
			} finally {
				this._deleteSession(event.remoteConnectionToken, session);
			}
		}
	}

	private _deleteSession(remoteConnectionToken: string, session: IRemoteExtensionHostProfileSession): void {
		if (this._sessions.get(remoteConnectionToken) === session) {
			this._sessions.delete(remoteConnectionToken);
			session.cts.dispose(true);
		}
	}

	private _logProfileResult(result: IRemoteExtensionHostProfileResult | undefined): void {
		if (!result) {
			return;
		}
		this._logService.warn(`UNRESPONSIVE remote extension host: saved PROFILE here: '${result.profilePath}'`);
	}
}

interface IRemoteExtensionHostProfileSession {
	readonly cts: CancellationTokenSource;
}
