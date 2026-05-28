/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { URI, UriComponents } from '../../../base/common/uri.js';
import { ExtHostChatEditingShape, MainContext, MainThreadChatEditingShape } from './extHost.protocol.js';
import { IExtHostRpcService } from './extHostRpcService.js';
import * as typeConvert from './extHostTypeConverters.js';

class ChatEditingSession extends Disposable implements vscode.chat.ChatEditingSession {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _pendingActions: vscode.chat.ChatEditingSessionAction[] = [];
	private readonly _onDidUserAction = this._register(new Emitter<vscode.chat.ChatEditingSessionAction>());

	get onDidUserAction(): Event<vscode.chat.ChatEditingSessionAction> {
		return (listener, thisArgs, disposables) => {
			const result = this._onDidUserAction.event(listener, thisArgs, disposables);
			if (this._pendingActions.length > 0) {
				const actions = [...this._pendingActions];
				this._pendingActions.length = 0;
				for (const action of actions) {
					this._onDidUserAction.fire(action);
				}
			}
			return result;
		};
	}

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
			kind: f.kind,
			added: f.added,
			removed: f.removed
		}));
		this._onDidChange.fire();
	}

	fireUserAction(action: { type: number; uri: UriComponents; isFromApi?: boolean; file: { uri: UriComponents; state: number; kind: number; added: number; removed: number } }) {
		const payload = {
			type: action.type as vscode.chat.ChatEditingSessionUserAction,
			uri: URI.revive(action.uri),
			isFromApi: action.isFromApi,
			file: {
				uri: URI.revive(action.file.uri),
				state: action.file.state,
				kind: action.file.kind,
				added: action.file.added,
				removed: action.file.removed
			}
		};

		if (this._onDidUserAction.hasListeners()) {
			this._onDidUserAction.fire(payload);
		} else {
			this._pendingActions.push(payload);
		}
	}

	override dispose() {
		this._proxy.$disposeEditingSession(this._handle);
		this._onDidDispose.fire();
		super.dispose();
	}
}

export interface IExtHostChatEditing extends ExtHostChatEditingShape {
	startEditingSession(options?: vscode.chat.ChatEditingSessionOptions): Promise<vscode.chat.ChatEditingSession>;
	setEditingEditorVisibility(visible: boolean): void;
	readonly onDidUnclaimedUserAction: Event<{ readonly chatSessionId: string }>;
}

export class ExtHostChatEditing implements IExtHostChatEditing {

	private readonly _proxy: MainThreadChatEditingShape;
	private readonly _sessions = new Map<number, ChatEditingSession>();
	private _nextHandle = 1;

	private readonly _unclaimedSessionIds = new Set<string>();
	private readonly _onDidUnclaimedUserAction = new Emitter<{ readonly chatSessionId: string }>();

	get onDidUnclaimedUserAction(): Event<{ readonly chatSessionId: string }> {
		return (listener, thisArgs, disposables) => {
			const result = this._onDidUnclaimedUserAction.event(listener, thisArgs, disposables);
			if (this._unclaimedSessionIds.size > 0) {
				for (const chatSessionId of this._unclaimedSessionIds) {
					try {
						listener.call(thisArgs, { chatSessionId });
					} catch (e) {
						// Error handling for synchronous listener execution
						console.error(e);
					}
				}
			}
			return result;
		};
	}

	constructor(
		extHostRpc: IExtHostRpcService
	) {
		this._proxy = extHostRpc.getProxy(MainContext.MainThreadChatEditing);
	}

	startEditingSession(options?: vscode.chat.ChatEditingSessionOptions): Promise<vscode.chat.ChatEditingSession> {
		if (options?.chatSessionId) {
			this._unclaimedSessionIds.delete(options.chatSessionId);
		}
		const handle = this._nextHandle++;
		const session = new ChatEditingSession(handle, this._proxy);
		this._sessions.set(handle, session);

		// In a real implementation we might want to wait for confirmation or handle disposal
		return this._proxy.$createEditingSession(handle, options?.chatSessionId).then((id) => {
			session._init(id);
			return session;
		});
	}

	setEditingEditorVisibility(visible: boolean): void {
		this._proxy.$setEditingEditorVisibility(visible);
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

	$onDidUnclaimedUserAction(chatSessionId: string): void {
		this._unclaimedSessionIds.add(chatSessionId);
		this._onDidUnclaimedUserAction.fire({ chatSessionId });
	}

	async $onDidUpdateSession(handle: number, files: { uri: UriComponents; state: number; kind: number; added: number; removed: number }[]): Promise<void> {
		const session = this._sessions.get(handle);
		session?.update(files);
	}
}
