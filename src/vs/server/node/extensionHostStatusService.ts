/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../platform/instantiation/common/instantiation.js';
import { IExtensionHostExitInfo } from '../../workbench/services/remote/common/remoteAgentService.js';

export const IExtensionHostStatusService = createDecorator<IExtensionHostStatusService>('extensionHostStatusService');

export interface IExtensionHostStatusService {
	readonly _serviceBrand: undefined;

	setExitInfo(reconnectionToken: string, info: IExtensionHostExitInfo): void;
	getExitInfo(reconnectionToken: string): IExtensionHostExitInfo | null;
	setProfileHandler(reconnectionToken: string, handler: () => Promise<string | undefined>): void;
	removeProfileHandler(reconnectionToken: string): void;
	profile(reconnectionToken: string): Promise<string | undefined>;
}

export class ExtensionHostStatusService implements IExtensionHostStatusService {
	_serviceBrand: undefined;

	private readonly _exitInfo = new Map<string, IExtensionHostExitInfo>();
	private readonly _profileHandlers = new Map<string, () => Promise<string | undefined>>();

	setExitInfo(reconnectionToken: string, info: IExtensionHostExitInfo): void {
		this._exitInfo.set(reconnectionToken, info);
	}

	getExitInfo(reconnectionToken: string): IExtensionHostExitInfo | null {
		return this._exitInfo.get(reconnectionToken) || null;
	}

	setProfileHandler(reconnectionToken: string, handler: () => Promise<string | undefined>): void {
		this._profileHandlers.set(reconnectionToken, handler);
	}

	removeProfileHandler(reconnectionToken: string): void {
		this._profileHandlers.delete(reconnectionToken);
	}

	async profile(reconnectionToken: string): Promise<string | undefined> {
		return this._profileHandlers.get(reconnectionToken)?.();
	}
}
