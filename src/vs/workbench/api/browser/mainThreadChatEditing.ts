/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap, IDisposable } from '../../../base/common/lifecycle.js';
import { autorun } from '../../../base/common/observable.js';
import { ExtHostChatEditingShape, ExtHostContext, IWorkspaceEditDto, MainContext, MainThreadChatEditingShape } from '../common/extHost.protocol.js';
import { extHostNamedCustomer, IExtHostContext } from '../../services/extensions/common/extHostCustomers.js';
import { IChatEditingService, IChatEditingSession, IModifiedFileEntry, ModifiedFileEntryState } from '../../contrib/chat/common/editing/chatEditingService.js';
import { IChatService } from '../../contrib/chat/common/chatService/chatService.js';

import { reviveWorkspaceEditDto } from './mainThreadBulkEdits.js';
import { ChatModel } from '../../contrib/chat/common/model/chatModel.js';
import { ChatAgentLocation } from '../../contrib/chat/common/constants.js';
import { IUriIdentityService } from '../../../platform/uriIdentity/common/uriIdentity.js';
import { ChatRequestTextPart } from '../../contrib/chat/common/requestParser/chatParserTypes.js';
import { OffsetRange } from '../../../editor/common/core/ranges/offsetRange.js';
import { Range } from '../../../editor/common/core/range.js';
import { URI, UriComponents } from '../../../base/common/uri.js';

@extHostNamedCustomer(MainContext.MainThreadChatEditing)
export class MainThreadChatEditing extends Disposable implements MainThreadChatEditingShape {

	private readonly _proxy: ExtHostChatEditingShape;
	private readonly _sessions = this._register(new DisposableMap<number, IChatEditingSession>());
	private readonly _sessionDisposables = this._register(new DisposableMap<number, IDisposable>());

	constructor(
		extHostContext: IExtHostContext,
		@IChatEditingService private readonly _chatEditingService: IChatEditingService,
		@IChatService private readonly _chatService: IChatService,
		@IUriIdentityService private readonly _uriIdentityService: IUriIdentityService
	) {
		super();
		this._proxy = extHostContext.getProxy(ExtHostContext.ExtHostChatEditing);
	}

	async $createEditingSession(handle: number, chatSessionId?: string): Promise<string> {
		let chatModel: ChatModel | undefined;
		if (chatSessionId) {
			const sessionUri = URI.parse(chatSessionId);
			const ref = await this._chatService.getOrRestoreSession(sessionUri);
			if (ref) {
				chatModel = ref.object as ChatModel;
				// We need to keep a reference to it so it doesn't get disposed
				this._register(ref);
			}
		}

		if (!chatModel) {
			const chatModelRef = this._chatService.startSession(ChatAgentLocation.Chat, {});
			if (!chatModelRef) {
				throw new Error('Failed to start chat session');
			}
			chatModel = chatModelRef.object as ChatModel;
			this._register(chatModelRef);
		}

		// Ensure we are working with the concrete class to access methods if needed, though interface should suffice for creation
		const session = this._chatEditingService.createEditingSession(chatModel);
		this._sessions.set(handle, session);

		const disposable = autorun(reader => {
			const entries = session.entries.read(reader);
			const files = entries
				.filter(entry => entry.state.read(reader) === ModifiedFileEntryState.Modified)
				.map(entry => ({
					uri: entry.modifiedURI,
					state: entry.state.read(reader),
					kind: entry.kind,
					added: entry.linesAdded?.read(reader) ?? 0,
					removed: entry.linesRemoved?.read(reader) ?? 0
				}));
			this._proxy.$onDidUpdateSession(handle, files);
		});

		this._sessionDisposables.set(handle, disposable);

		return session.chatSessionResource.toString();
	}

	async $disposeEditingSession(handle: number): Promise<void> {
		const session = this._sessions.get(handle);
		if (session) {
			await session.stop();
			this._sessions.deleteAndDispose(handle);
			this._sessionDisposables.deleteAndDispose(handle);
		}
	}

	async $applyEdits(handle: number, editDto: IWorkspaceEditDto, description: string = 'Extension Edit'): Promise<void> {
		const session = this._sessions.get(handle);
		if (!session) {
			throw new Error('Session not found');
		}

		const edits = reviveWorkspaceEditDto(editDto, this._uriIdentityService);
		if (!edits) {
			throw new Error('Failed to revive workspace edit');
		}

		const chatModel = this._chatService.getSession(session.chatSessionResource) as ChatModel;

		if (!chatModel) {
			throw new Error('Chat model not found');
		}

		// Create a request to house these edits
		const parts = [new ChatRequestTextPart(new OffsetRange(0, description.length), new Range(1, 1, 1, 1), description)];
		const request = chatModel.addRequest({ parts, text: description }, { variables: [] }, 0);

		// Ensure response exists
		const response = request.response;
		if (!response) {
			throw new Error('Response not found');
		}

		// Apply edits
		// We iterate over the WorkspaceEdit and stream them into the session
		for (const edit of edits.edits) {
			// Check if it is a text edit
			// eslint-disable-next-line local/code-no-in-operator
			if ('textEdit' in edit) {
				const uri = edit.resource;
				const textEdits = edit.textEdit;
				const stream = session.startStreamingEdits(uri, response, undefined);
				stream.pushText([textEdits], true);
				stream.complete();
			} else {
				// Handle file operations (create/delete/rename)
				// We need to filter out custom edits as they are not supported here
				// And ensure type safety for IWorkspaceFileEdit
				// eslint-disable-next-line local/code-no-any-casts, @typescript-eslint/no-explicit-any
				const workspaceEdit = edit as any;
				// eslint-disable-next-line local/code-no-in-operator
				if (!('textEdit' in workspaceEdit)) {
					session.applyWorkspaceEdit({
						kind: 'workspaceEdit',
						edits: [workspaceEdit]
					}, response, 'undoStop'); // Provide a dummy undoStop ID
				}
			}
		}

		// Mark response as complete
		response.complete();
	}

	async $accept(handle: number, uris?: UriComponents[]): Promise<void> {
		const session = this._sessions.get(handle);
		if (session) {
			const entries = session.entries.get();
			const targetUris = uris?.map(u => {
				const entry = this._findEntry(u, entries);
				if (entry) {
					return entry.modifiedURI;
				}
				// Fallback to revive if not found in session (though unlikely to work if not in session)
				return URI.revive(u);
			}) ?? entries.map(e => e.modifiedURI);
			await session.accept(...targetUris);
		}
	}

	async $reject(handle: number, uris?: UriComponents[]): Promise<void> {
		const session = this._sessions.get(handle);
		if (session) {
			const entries = session.entries.get();
			const targetUris = uris?.map(u => {
				const entry = this._findEntry(u, entries);
				if (entry) {
					return entry.modifiedURI;
				}
				return URI.revive(u);
			}) ?? entries.map(e => e.modifiedURI);
			await session.reject(...targetUris);
		}
	}

	async $show(handle: number, title?: string): Promise<void> {
		const session = this._sessions.get(handle);
		if (session) {
			await session.show(false, title);
		}
	}

	private _findEntry(uri: UriComponents, entries: readonly IModifiedFileEntry[]): IModifiedFileEntry | undefined {
		return entries.find(e => {
			const u = uri as (UriComponents & { fsPath?: string; external?: string });

			// Check 1: fsPath (if available) - Case insensitive for Windows/Mac
			if (typeof u.fsPath === 'string' && e.modifiedURI.fsPath.toLowerCase() === u.fsPath.toLowerCase()) {
				return true;
			}

			// Check 2: external/toString() (if available)
			if (typeof u.external === 'string' && e.modifiedURI.toString() === u.external) {
				return true;
			}

			// Check 3: scheme and path
			if (u.scheme === e.modifiedURI.scheme && u.path === e.modifiedURI.path) {
				return true;
			}

			// Check 4: path only (fallback)
			if (u.path && e.modifiedURI.path === u.path) {
				return true;
			}

			return false;
		});
	}
}
