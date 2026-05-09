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

	private readonly _onDidUserAction = this._register(new Emitter<vscode.chat.ChatEditingSessionAction>());
	readonly onDidUserAction = this._onDidUserAction.event;

	private readonly _onDidDispose = this._register(new Emitter<void>());
	readonly onDidDispose = this._onDidDispose.event;

	private _id: string = '';
	get id(): string {
		return this._id;
	}

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

	async applyEdits(edit: vscode.WorkspaceEdit, description?: string): Promise<vscode.chat.ChatEditingSessionApplyEditsResult> {
		const dto = typeConvert.WorkspaceEdit.from(edit);
		const result = await this._proxy.$applyEdits(this._handle, dto, description);

		const failedEdits = result.failedEdits?.map(f => ({
			uri: URI.revive(f.uri),
			reason: f.reason
		}));

		return {
			success: result.success,
			errorMessage: result.errorMessage,
			failedEdits
		};
	}

	async accept(uris?: vscode.Uri[]): Promise<void> {
		await this._proxy.$accept(this._handle, uris);
	}

	async reject(uris?: vscode.Uri[]): Promise<void> {
		await this._proxy.$reject(this._handle, uris);
	}

	async show(title?: string): Promise<void> {
		await this._proxy.$show(this._handle, title);
	}

	_init(id: string) {
		this._id = id;
	}

	update(files: { uri: UriComponents; state: number; kind: number; added: number; removed: number }[]) {
		this._files = files.map(f => ({
			uri: URI.revive(f.uri),
			state: f.state,
			isNew: f.kind === 0, // ChatEditKind.Created
			added: f.added,
			removed: f.removed
		}));
		this._onDidChange.fire();
	}

	fireUserAction(action: { type: number; uri: UriComponents; isFromApi?: boolean; file: { uri: UriComponents; state: number; kind: number; added: number; removed: number } }) {
		this._onDidUserAction.fire({
			type: action.type as vscode.chat.ChatEditingSessionUserAction,
			uri: URI.revive(action.uri),
			isFromApi: action.isFromApi,
			file: {
				uri: URI.revive(action.file.uri),
				state: action.file.state,
				isNew: action.file.kind === 0, // ChatEditKind.Created
				added: action.file.added,
				removed: action.file.removed
			}
		});
	}

	override dispose() {
		this._proxy.$disposeEditingSession(this._handle);
		this._onDidDispose.fire();
		super.dispose();
	}
}

export class ExtHostChatEditing implements ExtHostChatEditingShape {

	private readonly _proxy: MainThreadChatEditingShape;
	private readonly _sessions = new Map<number, ChatEditingSession>();
	private _nextHandle = 1;

	constructor(extHostRpc: IExtHostRpcService) {
		this._proxy = extHostRpc.getProxy(MainContext.MainThreadChatEditing);
	}

	startEditingSession(options?: vscode.chat.ChatEditingSessionOptions): Promise<vscode.chat.ChatEditingSession> {
		const handle = this._nextHandle++;
		const session = new ChatEditingSession(handle, this._proxy);
		this._sessions.set(handle, session);

		// In a real implementation we might want to wait for confirmation or handle disposal
		return this._proxy.$createEditingSession(handle, options?.chatSessionId).then((id) => {
			session._init(id);
			return session;
		});
	}

	async $accept(handle: number): Promise<void> {
		// Can be used to trigger local events if needed
	}

	async $reject(handle: number): Promise<void> {
		// Can be used to trigger local events if needed
	}

	$onDidUserAction(handle: number, action: { type: number; uri: UriComponents; isFromApi?: boolean; file: { uri: UriComponents; state: number; kind: number; added: number; removed: number } }): void {
		this._sessions.get(handle)?.fireUserAction(action);
	}

	async $onDidUpdateSession(handle: number, files: { uri: UriComponents; state: number; kind: number; added: number; removed: number }[]): Promise<void> {
		const session = this._sessions.get(handle);
		session?.update(files);
	}
}
