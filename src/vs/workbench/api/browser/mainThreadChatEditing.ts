/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap, IDisposable } from '../../../base/common/lifecycle.js';
import { autorun } from '../../../base/common/observable.js';
import { ExtHostChatEditingShape, ExtHostContext, IWorkspaceEditDto, MainContext, MainThreadChatEditingShape } from '../common/extHost.protocol.js';
import { extHostNamedCustomer, IExtHostContext } from '../../services/extensions/common/extHostCustomers.js';
import { IChatEditingService, IChatEditingSession } from '../../contrib/chat/common/editing/chatEditingService.js';
import { IChatService } from '../../contrib/chat/common/chatService/chatService.js';

import { reviveWorkspaceEditDto } from './mainThreadBulkEdits.js';
import { ChatModel } from '../../contrib/chat/common/model/chatModel.js';
import { ChatAgentLocation } from '../../contrib/chat/common/constants.js';
import { IUriIdentityService } from '../../../platform/uriIdentity/common/uriIdentity.js';
import { ChatRequestTextPart } from '../../contrib/chat/common/requestParser/chatParserTypes.js';
import { OffsetRange } from '../../../editor/common/core/ranges/offsetRange.js';
import { Range } from '../../../editor/common/core/range.js';

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

	async $createEditingSession(handle: number): Promise<void> {
		const chatModelRef = this._chatService.startSession(ChatAgentLocation.Chat, {});
		if (!chatModelRef) {
			throw new Error('Failed to start chat session');
		}

		const chatModel = chatModelRef.object as ChatModel;

		// Ensure we are working with the concrete class to access methods if needed, though interface should suffice for creation
		const session = this._chatEditingService.createEditingSession(chatModel);
		this._sessions.set(handle, session);

		const disposable = autorun(reader => {
			const entries = session.entries.read(reader);
			const files = entries.map(entry => ({
				uri: entry.modifiedURI,
				state: entry.state.read(reader),
				added: entry.linesAdded?.read(reader) ?? 0,
				removed: entry.linesRemoved?.read(reader) ?? 0
			}));
			this._proxy.$onDidUpdateSession(handle, files);
		});

		this._sessionDisposables.set(handle, disposable);
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
			if ('textEdit' in edit) {
				const uri = edit.resource;
				const textEdits = edit.textEdit;
				const stream = session.startStreamingEdits(uri, response, undefined);
				stream.pushText([textEdits], true);
				stream.complete();
			}
			// TODO: Handle file operations (create/delete/rename)
		}

		// Mark response as complete
		response.complete();
	}

	async $accept(handle: number): Promise<void> {
		const session = this._sessions.get(handle);
		if (session) {
			const uris = session.entries.get().map(e => e.modifiedURI);
			await session.accept(...uris);
		}
	}

	async $reject(handle: number): Promise<void> {
		const session = this._sessions.get(handle);
		if (session) {
			const uris = session.entries.get().map(e => e.modifiedURI);
			await session.reject(...uris);
		}
	}
}
