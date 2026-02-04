/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { URI, UriComponents } from '../../../base/common/uri.js';
import { ExtHostChatEditingShape, MainContext, MainThreadChatEditingShape } from './extHost.protocol.js';
import { IExtHostRpcService } from './extHostRpcService.js';
import * as typeConvert from './extHostTypeConverters.js';

class ChatEditingSession extends Disposable implements vscode.chat.ChatEditingSession {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private _files: vscode.chat.ChatEditingFile[] = [];
	get files(): readonly vscode.chat.ChatEditingFile[] {
		return this._files;
	}

	constructor(
		private readonly _handle: number,
		private readonly _proxy: MainThreadChatEditingShape
	) {
		super();
	}

	async applyEdits(edit: vscode.WorkspaceEdit, description?: string): Promise<void> {
		const dto = typeConvert.WorkspaceEdit.from(edit);
		await this._proxy.$applyEdits(this._handle, dto, description);
	}

	async accept(): Promise<void> {
		await this._proxy.$accept(this._handle);
	}

	async reject(): Promise<void> {
		await this._proxy.$reject(this._handle);
	}

	update(files: { uri: UriComponents; state: number; added: number; removed: number }[]) {
		this._files = files.map(f => ({
			uri: URI.revive(f.uri),
			state: f.state,
			added: f.added,
			removed: f.removed
		}));
		this._onDidChange.fire();
	}
}

export class ExtHostChatEditing implements ExtHostChatEditingShape {

	private readonly _proxy: MainThreadChatEditingShape;
	private readonly _sessions = new Map<number, ChatEditingSession>();
	private _nextHandle = 1;

	constructor(extHostRpc: IExtHostRpcService) {
		this._proxy = extHostRpc.getProxy(MainContext.MainThreadChatEditing);
	}

	async createEditingSession(): Promise<vscode.chat.ChatEditingSession> {
		const handle = this._nextHandle++;
		const session = new ChatEditingSession(handle, this._proxy);
		this._sessions.set(handle, session);
		
		// In a real implementation we might want to wait for confirmation or handle disposal
		await this._proxy.$createEditingSession(handle);
		
		return session;
	}

	async $accept(handle: number): Promise<void> {
		// Can be used to trigger local events if needed
	}

	async $reject(handle: number): Promise<void> {
		// Can be used to trigger local events if needed
	}

	async $onDidUpdateSession(handle: number, files: { uri: UriComponents; state: number; added: number; removed: number }[]): Promise<void> {
		const session = this._sessions.get(handle);
		session?.update(files);
	}
}
