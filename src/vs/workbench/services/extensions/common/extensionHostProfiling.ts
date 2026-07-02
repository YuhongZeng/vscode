/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const remoteExtensionHostProfilingEnabledSetting = 'extensions.remoteExtensionHostProfiling.enabled';
export const remoteExtensionHostProfilingDuration = 5000;
export const remoteExtensionHostProfileThrottleTime = 60000;

export interface IRemoteExtensionHostProfileExtension {
	readonly id: string;
	readonly location: string;
	readonly main?: string;
}

export interface IRemoteExtensionHostProfileResult {
	readonly profilePath: string;
	readonly summaryPath?: string;
	readonly topExtensionId?: string;
	readonly topExtensionLocation?: string;
	readonly topExtensionEntryPoint?: string;
	readonly topExtensionTotalTime?: number;
	readonly topFile?: string;
	readonly topFileTotalTime?: number;
}
