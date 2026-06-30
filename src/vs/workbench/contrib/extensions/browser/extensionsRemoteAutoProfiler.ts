/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ExtensionHostKind } from '../../../services/extensions/common/extensionHostKind.js';
import { remoteExtensionHostProfilingEnabledSetting } from '../../../services/extensions/common/extensionHostProfiling.js';
import { IExtensionService, IResponsiveStateChangeEvent } from '../../../services/extensions/common/extensions.js';
import { IRemoteAgentService } from '../../../services/remote/common/remoteAgentService.js';

export class ExtensionsRemoteAutoProfiler extends Disposable implements IWorkbenchContribution {

	constructor(
		@IExtensionService extensionService: IExtensionService,
		@IRemoteAgentService private readonly _remoteAgentService: IRemoteAgentService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService
	) {
		super();
		this._register(extensionService.onDidChangeResponsiveChange(this._onDidChangeResponsiveChange, this));
	}

	private _onDidChangeResponsiveChange(event: IResponsiveStateChangeEvent): void {
		if (event.extensionHostKind !== ExtensionHostKind.Remote || event.isResponsive) {
			return;
		}
		if (this._configurationService.getValue<boolean>(remoteExtensionHostProfilingEnabledSetting) !== true) {
			return;
		}
		if (!event.remoteConnectionToken) {
			this._logService.warn('UNRESPONSIVE remote extension host: cannot profile because there is no remote connection token.');
			return;
		}

		this._remoteAgentService.profileExtensionHost(event.remoteConnectionToken, event.remoteProfileExtensions ?? []).then(result => {
			if (result) {
				this._logService.warn(`UNRESPONSIVE remote extension host: saved PROFILE here: '${result.profilePath}'`);
				if (result.topExtensionId) {
					this._logService.warn(`UNRESPONSIVE remote extension host: top extension '${result.topExtensionId}', entry '${result.topExtensionEntryPoint ?? 'unknown'}', file '${result.topFile ?? 'unknown'}', extension location '${result.topExtensionLocation ?? 'unknown'}'`);
				}
				if (result.summaryPath) {
					this._logService.warn(`UNRESPONSIVE remote extension host: saved PROFILE SUMMARY here: '${result.summaryPath}'`);
				}
			}
		}, err => {
			this._logService.error('UNRESPONSIVE remote extension host: failed to request CPU profile.');
			this._logService.error(err);
		});
	}
}
