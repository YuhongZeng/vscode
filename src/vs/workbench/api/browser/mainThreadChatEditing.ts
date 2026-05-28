/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { combinedDisposable, Disposable, DisposableMap, IDisposable } from '../../../base/common/lifecycle.js';
import { autorun } from '../../../base/common/observable.js';
import { RunOnceScheduler } from '../../../base/common/async.js';
import { ExtHostChatEditingShape, ExtHostContext, IApplyEditsResultDto, IWorkspaceEditDto, MainContext, MainThreadChatEditingShape } from '../common/extHost.protocol.js';
import { extHostNamedCustomer, IExtHostContext } from '../../services/extensions/common/extHostCustomers.js';
import { IChatEditingService, IChatEditingSession, IModifiedFileEntry, ModifiedFileEntryState } from '../../contrib/chat/common/editing/chatEditingService.js';
import { IChatService } from '../../contrib/chat/common/chatService/chatService.js';
import { ITextFileService } from '../../services/textfile/common/textfiles.js';
import { IFilesConfigurationService } from '../../services/filesConfiguration/common/filesConfigurationService.js';

import { reviveWorkspaceEditDto } from './mainThreadBulkEdits.js';
import { ChatModel } from '../../contrib/chat/common/model/chatModel.js';
import { ChatAgentLocation } from '../../contrib/chat/common/constants.js';
import { IUriIdentityService } from '../../../platform/uriIdentity/common/uriIdentity.js';
import { IExtensionService } from '../../services/extensions/common/extensions.js';
import { ChatRequestTextPart } from '../../contrib/chat/common/requestParser/chatParserTypes.js';
import { OffsetRange } from '../../../editor/common/core/ranges/offsetRange.js';
import { Range } from '../../../editor/common/core/range.js';
import { IWorkspaceFileEdit } from '../../../editor/common/languages.js';
import { URI, UriComponents } from '../../../base/common/uri.js';

@extHostNamedCustomer(MainContext.MainThreadChatEditing)
export class MainThreadChatEditing extends Disposable implements MainThreadChatEditingShape {

	private readonly _proxy: ExtHostChatEditingShape;
	private readonly _sessions = this._register(new DisposableMap<number, IChatEditingSession>());
	private readonly _sessionDisposables = this._register(new DisposableMap<number, IDisposable>());
	private readonly _unclaimedActions = new Map<string, { type: number; uri: UriComponents; isFromApi?: boolean; file: { uri: UriComponents; state: number; kind: number; added: number; removed: number } }[]>();

	constructor(
		extHostContext: IExtHostContext,
		@IChatEditingService private readonly _chatEditingService: IChatEditingService,
		@IChatService private readonly _chatService: IChatService,
		@IUriIdentityService private readonly _uriIdentityService: IUriIdentityService,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@IFilesConfigurationService private readonly _filesConfigurationService: IFilesConfigurationService,
		@IExtensionService private readonly _extensionService: IExtensionService
	) {
		super();
		this._proxy = extHostContext.getProxy(ExtHostContext.ExtHostChatEditing);

		this._register(this._chatService.onDidPerformUserAction(e => {
			if (e.action.kind === 'chatEditingSessionAction' || e.action.kind === 'chatEditingHunkAction') {

				const actionUri = e.action.uri;
				const allGlobalSessions = this._chatEditingService.editingSessionsObs.get();
				const relatedSessions = allGlobalSessions.filter(s => s.getEntry(actionUri));

				for (const globalSession of relatedSessions) {
					const entry = globalSession.getEntry(actionUri);
					if (!entry) {
						continue;
					}

					let type: number;
					if (e.action.kind === 'chatEditingSessionAction') {
						if (e.action.outcome === 'userModified') {
							continue;
						}
						type = e.action.outcome === 'accepted' ? 1 /* FileAccepted */ : 2 /* FileRejected */;
					} else {
						type = e.action.outcome === 'accepted' ? 3 /* HunkAccepted */ : 4 /* HunkRejected */;
					}

					const state = entry.state.get();
					const isModified = state === ModifiedFileEntryState.Modified;
					const fileInfo = {
						uri: entry.modifiedURI,
						state,
						kind: entry.kind,
						added: isModified ? (entry.linesAdded?.get() ?? 0) : 0,
						removed: isModified ? (entry.linesRemoved?.get() ?? 0) : 0
					};
					const actionPayload = { type, uri: actionUri, isFromApi: e.action.kind === 'chatEditingSessionAction' ? e.action.isFromApi : false, file: fileInfo };

					// Check if this globalSession is claimed
					let handle: number | undefined;
					for (const [h, s] of this._sessions) {
						if (s.chatSessionResource.toString() === globalSession.chatSessionResource.toString()) {
							handle = h;
							break;
						}
					}

					if (handle !== undefined) {
						// Claimed session
						this._proxy.$onDidUserAction(handle, actionPayload);
					} else {
						// Unclaimed session
						const chatSessionId = globalSession.chatSessionResource.toString();
						let actions = this._unclaimedActions.get(chatSessionId);
						if (!actions) {
							actions = [];
							this._unclaimedActions.set(chatSessionId, actions);
						}
						actions.push(actionPayload);
						this._proxy.$onDidUnclaimedUserAction(chatSessionId);
						this._extensionService.activateByEvent(`onChatEditingSession:${chatSessionId}`);
						this._extensionService.activateByEvent(`onChatEditingSession`);
					}
				}
			}
		}));
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
		const session = this._chatEditingService.startOrContinueGlobalEditingSession(chatModel);
		this._sessions.set(handle, session);

		const chatSessionIdStr = session.chatSessionResource.toString();
		const pendingActions = this._unclaimedActions.get(chatSessionIdStr);
		if (pendingActions) {
			for (const action of pendingActions) {
				this._proxy.$onDidUserAction(handle, action);
			}
			this._unclaimedActions.delete(chatSessionIdStr);
		}

		const updateScheduler = new RunOnceScheduler(() => {
			const entries = session.entries.get();
			const files = entries
				.filter(entry => entry.state.get() === ModifiedFileEntryState.Modified)
				.map(entry => ({
					uri: entry.modifiedURI,
					state: entry.state.get(),
					kind: entry.kind,
					added: entry.linesAdded?.get() ?? 0,
					removed: entry.linesRemoved?.get() ?? 0
				}));
			this._proxy.$onDidUpdateSession(handle, files);
		}, 50);

		const disposable = autorun(reader => {
			const entries = session.entries.read(reader);
			for (const entry of entries) {
				entry.state.read(reader);
				entry.linesAdded?.read(reader);
				entry.linesRemoved?.read(reader);
			}
			if (!updateScheduler.isScheduled()) {
				updateScheduler.schedule();
			}
		});

		this._sessionDisposables.set(handle, combinedDisposable(disposable, updateScheduler));

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

	async $applyEdits(handle: number, editDto: IWorkspaceEditDto, description: string = 'Extension Edit'): Promise<IApplyEditsResultDto> {
		try {
			const session = this._sessions.get(handle);
			if (!session) {
				return { success: false, errorMessage: 'Session not found' };
			}

			const edits = reviveWorkspaceEditDto(editDto, this._uriIdentityService);
			if (!edits) {
				return { success: false, errorMessage: 'Failed to revive workspace edit' };
			}

			// Pre-flight check: ensure none of the files are read-only
			const failedEdits: { uri: UriComponents; reason: string }[] = [];
			for (const edit of edits.edits) {
				// eslint-disable-next-line local/code-no-in-operator
				if ('textEdit' in edit) {
					if (this._filesConfigurationService.isReadonly(edit.resource)) {
						failedEdits.push({ uri: edit.resource, reason: `Error: Unable to write file '${edit.resource.toString()}' (File is read-only)` });
					}
				} else {
					const workspaceFileEdit = edit as IWorkspaceFileEdit;
					if (workspaceFileEdit.newResource && this._filesConfigurationService.isReadonly(workspaceFileEdit.newResource)) {
						failedEdits.push({ uri: workspaceFileEdit.newResource, reason: `Error: Unable to write file '${workspaceFileEdit.newResource.toString()}' (File is read-only)` });
					}
					if (workspaceFileEdit.oldResource && this._filesConfigurationService.isReadonly(workspaceFileEdit.oldResource)) {
						failedEdits.push({ uri: workspaceFileEdit.oldResource, reason: `Error: Unable to write file '${workspaceFileEdit.oldResource.toString()}' (File is read-only)` });
					}
				}
			}

			if (failedEdits.length > 0) {
				return { success: false, errorMessage: 'One or more files are read-only', failedEdits };
			}

			const chatModel = this._chatService.getSession(session.chatSessionResource) as ChatModel;

			if (!chatModel) {
				return { success: false, errorMessage: 'Chat model not found' };
			}

			// Create a request to house these edits
			const parts = [new ChatRequestTextPart(new OffsetRange(0, description.length), new Range(1, 1, 1, 1), description)];
			const request = chatModel.addRequest({ parts, text: description }, { variables: [] }, 0);

			// Ensure response exists
			const response = request.response;
			if (!response) {
				return { success: false, errorMessage: 'Response not found' };
			}

			// Apply edits
			// We iterate over the WorkspaceEdit and stream them into the session
			const completePromises: Promise<void>[] = [];
			for (const edit of edits.edits) {
				// Check if it is a text edit
				// eslint-disable-next-line local/code-no-in-operator
				if ('textEdit' in edit) {
					const uri = edit.resource;
					const textEdits = edit.textEdit;
					const stream = session.startStreamingEdits(uri, response, undefined);
					stream.pushText([textEdits], true);
					const p = stream.complete();
					if (p) {
						completePromises.push(p);
					}
				} else {
					// Handle file operations (create/delete/rename)
					// We need to filter out custom edits as they are not supported here
					// And ensure type safety for IWorkspaceFileEdit
					const workspaceFileEdit = edit as IWorkspaceFileEdit;
					// eslint-disable-next-line local/code-no-in-operator
					if (!('textEdit' in workspaceFileEdit)) {
						session.applyWorkspaceEdit({
							kind: 'workspaceEdit',
							edits: [workspaceFileEdit]
						}, response, 'undoStop'); // Provide a dummy undoStop ID
					}
				}
			}

			// Wait for all streaming edits to be fully applied by the background sequencer
			if (completePromises.length > 0) {
				await Promise.all(completePromises);
			}

			// Mark response as complete
			response.complete();

			// Collect all modified URIs
			const modifiedUris = new Map<string, URI>();
			for (const edit of edits.edits) {
				// eslint-disable-next-line local/code-no-in-operator
				if ('textEdit' in edit) {
					modifiedUris.set(edit.resource.toString(), edit.resource);
				} else {
					const workspaceFileEdit = edit as IWorkspaceFileEdit;
					if (workspaceFileEdit.newResource) {
						modifiedUris.set(workspaceFileEdit.newResource.toString(), workspaceFileEdit.newResource);
					}
				}
			}

			const saveResults = await Promise.all(Array.from(modifiedUris.values()).map(async uri => {
				try {
					const result = await this._textFileService.save(uri, { ignoreErrorHandler: true });
					if (!result) {
						return { uri, success: false, reason: 'Save operation was cancelled or failed implicitly' };
					}
					return { uri, success: true };
				} catch (error) {
					return { uri, success: false, reason: error instanceof Error ? error.toString() : String(error) };
				}
			}));

			const failedSaves = saveResults.filter(r => !r.success);
			if (failedSaves.length > 0) {
				const saveFailedEdits: { uri: UriComponents; reason: string }[] = failedSaves.map(f => ({
					uri: f.uri,
					reason: f.reason || 'Failed to save to disk'
				}));

				// Revert the dirty state for files that failed to save
				const urisToReject = failedSaves.map(f => f.uri);
				session.isAcceptingFromApi = true;
				try {
					await session.reject(...urisToReject);
				} finally {
					session.isAcceptingFromApi = false;
				}

				return {
					success: false,
					errorMessage: 'Failed to save one or more files to disk. The files might be read-only or the save operation was cancelled.',
					failedEdits: saveFailedEdits
				};
			}
			return { success: true };
		} catch (err) {
			if (err instanceof Error) {
				return { success: false, errorMessage: err.message };
			}
			return { success: false, errorMessage: 'Unknown error occurred while applying edits' };
		}
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
			session.isAcceptingFromApi = true;
			try {
				await session.accept(...targetUris);
			} finally {
				session.isAcceptingFromApi = false;
			}
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
			session.isAcceptingFromApi = true;
			try {
				await session.reject(...targetUris);
			} finally {
				session.isAcceptingFromApi = false;
			}
		}
	}

	async $show(handle: number, title?: string): Promise<void> {
		const session = this._sessions.get(handle);
		if (session) {
			await session.show(undefined, title);
		}
	}

	async $setEditingEditorVisibility(visible: boolean): Promise<void> {
		this._chatEditingService.setEditingEditorVisibility(visible);
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
