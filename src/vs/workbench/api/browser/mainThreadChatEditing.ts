/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { combinedDisposable, Disposable, DisposableMap, IDisposable } from '../../../base/common/lifecycle.js';
import { autorun } from '../../../base/common/observable.js';
import { RunOnceScheduler, timeout } from '../../../base/common/async.js';
import { ExtHostChatEditingShape, ExtHostContext, IApplyEditsResultDto, IChatEditingDisplayDiffDto, IChatEditingDisplayLineRangeDto, IChatEditingTextDiffHunkDto, IChatEditingTextDisplayDiffDto, IWorkspaceEditDto, MainContext, MainThreadChatEditingShape } from '../common/extHost.protocol.js';
import { extHostNamedCustomer, IExtHostContext } from '../../services/extensions/common/extHostCustomers.js';
import { awaitCompleteChatEditingDiff, IChatEditingService, IChatEditingSession, IEditSessionEntryDiff, IModifiedFileEntry, ModifiedFileEntryState } from '../../contrib/chat/common/editing/chatEditingService.js';
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
import { FileOperationResult, FileSystemProviderErrorCode, toFileOperationResult, toFileSystemProviderErrorCode } from '../../../platform/files/common/files.js';

const applyEditsBeforeSnapshotId = 'chatEditingApplyEditsBefore';
const applyEditsAfterSnapshotId = 'chatEditingApplyEditsAfter';
const MAX_UNCLAIMED_CHAT_EDITING_SESSIONS = 100;
const MAX_UNCLAIMED_CHAT_EDITING_ACTIONS_PER_SESSION = 100;
const chatEditingSaveRetryDelays = [50, 150, 300];
const transientChatEditingSaveErrorCodes = new Set(['EACCES', 'EAGAIN', 'EBUSY', 'ECONNRESET', 'EMFILE', 'ENFILE', 'EPERM', 'EPIPE', 'ETIMEDOUT']);
const transientChatEditingSaveErrorMessages = [
	'sharing violation',
	'lock violation',
	'used by another process',
	'being used by another process',
	'cannot access the file because it is being used by another process'
];

@extHostNamedCustomer(MainContext.MainThreadChatEditing)
export class MainThreadChatEditing extends Disposable implements MainThreadChatEditingShape {

	private readonly _proxy: ExtHostChatEditingShape;
	private readonly _sessions = this._register(new DisposableMap<number, IChatEditingSession>());
	private readonly _sessionDisposables = this._register(new DisposableMap<number, IDisposable>());
	private readonly _disposingSessions = new Set<number>();
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
							if (this._unclaimedActions.size >= MAX_UNCLAIMED_CHAT_EDITING_SESSIONS) {
								const oldest = this._unclaimedActions.keys().next().value;
								if (oldest) {
									this._unclaimedActions.delete(oldest);
								}
							}
							actions = [];
							this._unclaimedActions.set(chatSessionId, actions);
						}
						if (actions.length >= MAX_UNCLAIMED_CHAT_EDITING_ACTIONS_PER_SESSION) {
							actions.shift();
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
		let chatModelRef: IDisposable | undefined;

		let chatModel: ChatModel | undefined;
		if (chatSessionId) {
			const sessionUri = URI.parse(chatSessionId);
			const ref = await this._chatService.getOrRestoreSession(sessionUri);
			if (ref) {
				chatModel = ref.object as ChatModel;
				chatModelRef = ref;
			}
		}

		if (!chatModel) {
			chatModelRef = this._chatService.startSession(ChatAgentLocation.Chat, {});
			if (!chatModelRef) {
				throw new Error('Failed to start chat session');
			}
			chatModel = chatModelRef.object as ChatModel;
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
		if (chatSessionId) {
			this._unclaimedActions.delete(chatSessionId);
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

		const sessionDisposeListener = session.onDidDispose(() => {
			if (this._disposingSessions.has(handle)) {
				return;
			}

			this._sessions.deleteAndLeak(handle);
			this._sessionDisposables.deleteAndDispose(handle);
			this._proxy.$onDidDisposeSession(handle);
		});

		this._sessionDisposables.set(handle, combinedDisposable(chatModelRef ?? Disposable.None, disposable, updateScheduler, sessionDisposeListener));

		return session.chatSessionResource.toString();
	}

	async $disposeEditingSession(handle: number): Promise<void> {
		const session = this._sessions.get(handle);
		if (session) {
			await session.stop();
			this._disposingSessions.add(handle);
			try {
				this._sessionDisposables.deleteAndDispose(handle);
				this._sessions.deleteAndDispose(handle);
			} finally {
				this._disposingSessions.delete(handle);
			}
		}
	}

	async $applyEdits(handle: number, editDto: IWorkspaceEditDto, description: string = 'Extension Edit'): Promise<IApplyEditsResultDto> {
		try {
			const session = this._sessions.get(handle);
			if (!session) {
				return { success: false, errorMessage: 'Session not found', displayDiff: [] };
			}

			const edits = reviveWorkspaceEditDto(editDto, this._uriIdentityService);
			if (!edits) {
				return { success: false, errorMessage: 'Failed to revive workspace edit', displayDiff: [] };
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
				return { success: false, errorMessage: 'One or more files are read-only', failedEdits, displayDiff: [] };
			}

			const chatModel = this._chatService.getSession(session.chatSessionResource) as ChatModel;

			if (!chatModel) {
				return { success: false, errorMessage: 'Chat model not found', displayDiff: [] };
			}

			// Create a request to house these edits
			const parts = [new ChatRequestTextPart(new OffsetRange(0, description.length), new Range(1, 1, 1, 1), description)];
			const request = chatModel.addRequest({ parts, text: description }, { variables: [] }, 0);

			// Ensure response exists
			const response = request.response;
			if (!response) {
				return { success: false, errorMessage: 'Response not found', displayDiff: [] };
			}

			session.createSnapshot(request.id, applyEditsBeforeSnapshotId);

			// Apply edits
			// We iterate over the WorkspaceEdit and stream them into the session
			const applyPromises: Promise<void>[] = [];
			for (const edit of edits.edits) {
				// Check if it is a text edit
				// eslint-disable-next-line local/code-no-in-operator
				if ('textEdit' in edit) {
					const uri = edit.resource;
					const textEdits = edit.textEdit;
					const stream = session.startStreamingEdits(uri, response, applyEditsAfterSnapshotId);
					stream.pushText([textEdits], true);
					const p = stream.complete({ createSnapshot: false });
					if (p) {
						applyPromises.push(p);
					}
				} else {
					// Handle file operations (create/delete/rename)
					// We need to filter out custom edits as they are not supported here
					// And ensure type safety for IWorkspaceFileEdit
					const workspaceFileEdit = edit as IWorkspaceFileEdit;
					// eslint-disable-next-line local/code-no-in-operator
					if (!('textEdit' in workspaceFileEdit)) {
						applyPromises.push(session.applyWorkspaceEdit({
							kind: 'workspaceEdit',
							edits: [workspaceFileEdit]
						}, response, applyEditsAfterSnapshotId));
					}
				}
			}

			// Wait for all text and file operations to settle before capturing the after snapshot.
			if (applyPromises.length > 0) {
				await Promise.all(applyPromises);
			}

			session.createSnapshot(request.id, applyEditsAfterSnapshotId);

			// Mark response as complete
			response.complete();

			// Only text edits need an explicit save here. Pure file operations such as
			// createFile/renameFile are already applied to disk by the bulk edit service.
			const modifiedUris = new Map<string, { uri: URI; requiresSave: boolean }>();
			for (const edit of edits.edits) {
				// eslint-disable-next-line local/code-no-in-operator
				if ('textEdit' in edit) {
					modifiedUris.set(edit.resource.toString(), { uri: edit.resource, requiresSave: true });
				} else {
					const workspaceFileEdit = edit as IWorkspaceFileEdit;
					if (workspaceFileEdit.newResource) {
						const key = workspaceFileEdit.newResource.toString();
						const existing = modifiedUris.get(key);
						modifiedUris.set(key, { uri: workspaceFileEdit.newResource, requiresSave: existing?.requiresSave ?? false });
					}
				}
			}

			const saveResults = await Promise.all(Array.from(modifiedUris.values()).map(async ({ uri, requiresSave }) => {
				if (!requiresSave) {
					return { uri, success: true };
				}

				return this._saveWithRetries(uri);
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
					failedEdits: saveFailedEdits,
					displayDiff: []
				};
			}
			const displayDiff = await this._computeDisplayDiff(session, editDto, request.id);
			return { success: true, displayDiff };
		} catch (err) {
			if (err instanceof Error) {
				return { success: false, errorMessage: err.message, displayDiff: [] };
			}
			return { success: false, errorMessage: 'Unknown error occurred while applying edits', displayDiff: [] };
		}
	}

	private async _computeDisplayDiff(session: IChatEditingSession, editDto: IWorkspaceEditDto, requestId: string): Promise<IChatEditingDisplayDiffDto[]> {
		const displayDiff: IChatEditingDisplayDiffDto[] = [];
		const textDiffResources = new Map<string, { uri: URI; changeType: IChatEditingTextDisplayDiffDto['changeType'] }>();

		for (const edit of editDto.edits) {
			// eslint-disable-next-line local/code-no-in-operator
			if ('textEdit' in edit || 'cellEdit' in edit) {
				const uri = URI.revive(edit.resource);
				this._recordTextDiffResource(textDiffResources, uri, 'modify');
				continue;
			}

			if (edit.oldResource && edit.newResource) {
				displayDiff.push({ type: 'rename', oldUri: edit.oldResource, newUri: edit.newResource });
			} else if (edit.newResource) {
				displayDiff.push({ type: 'create', uri: edit.newResource });
				this._recordTextDiffResource(textDiffResources, URI.revive(edit.newResource), 'create');
			} else if (edit.oldResource) {
				displayDiff.push({ type: 'delete', uri: edit.oldResource });
				this._recordTextDiffResource(textDiffResources, URI.revive(edit.oldResource), 'delete');
			}
		}

		for (const { uri, changeType } of textDiffResources.values()) {
			const originalUri = session.getSnapshotUri(requestId, uri, applyEditsBeforeSnapshotId);
			const modifiedUri = session.getSnapshotUri(requestId, uri, applyEditsAfterSnapshotId);
			if (!originalUri || !modifiedUri) {
				continue;
			}

			const diffObservable = session.getEntryDiffBetweenStops(uri, requestId, applyEditsBeforeSnapshotId);
			if (!diffObservable) {
				continue;
			}

			const textDisplayDiff = this._createTextDisplayDiff(
				uri,
				changeType,
				originalUri,
				modifiedUri,
				await awaitCompleteChatEditingDiff(diffObservable)
			);
			if (textDisplayDiff) {
				displayDiff.push(textDisplayDiff);
			}
		}

		return displayDiff;
	}

	private async _saveWithRetries(uri: URI): Promise<{ uri: URI; success: true } | { uri: URI; success: false; reason: string }> {
		for (let attempt = 0; ; attempt++) {
			try {
				const result = await this._textFileService.save(uri, { ignoreErrorHandler: true });
				if (!result) {
					return { uri, success: false, reason: 'Save operation was cancelled or failed implicitly' };
				}

				return { uri, success: true };
			} catch (error) {
				const isRetryableTransientSaveError = this._isRetryableTransientSaveError(error);
				if (attempt < chatEditingSaveRetryDelays.length && isRetryableTransientSaveError) {
					await timeout(chatEditingSaveRetryDelays[attempt]);
					continue;
				}

				return {
					uri,
					success: false,
					reason: this._toSaveFailureReason(error, attempt + 1, isRetryableTransientSaveError)
				};
			}
		}
	}

	private _isRetryableTransientSaveError(error: unknown): boolean {
		if (!(error instanceof Error)) {
			return false;
		}

		const providerErrorCode = toFileSystemProviderErrorCode(error);
		if (providerErrorCode === FileSystemProviderErrorCode.Unavailable) {
			return true;
		}

		if (providerErrorCode !== FileSystemProviderErrorCode.Unknown || toFileOperationResult(error) !== FileOperationResult.FILE_OTHER_ERROR) {
			return false;
		}

		return this._hasTransientSaveErrorCode(error);
	}

	private _hasTransientSaveErrorCode(error: Error): boolean {
		let current: unknown = error;

		while (current && typeof current === 'object') {
			const candidate = current as { code?: unknown; cause?: unknown };
			if (typeof candidate.code === 'string' && transientChatEditingSaveErrorCodes.has(candidate.code)) {
				return true;
			}

			current = candidate.cause;
		}

		const message = error.message.toLowerCase();
		return Array.from(transientChatEditingSaveErrorCodes).some(code => error.message.includes(code))
			|| transientChatEditingSaveErrorMessages.some(fragment => message.includes(fragment));
	}

	private _toSaveFailureReason(error: unknown, attempts: number, wasRetried: boolean): string {
		const errorMessage = error instanceof Error ? error.toString() : String(error);
		if (!wasRetried || attempts <= 1) {
			return errorMessage;
		}

		return `Save failed after ${attempts} attempts (${attempts - 1} retries): ${errorMessage}`;
	}

	private _recordTextDiffResource(
		textDiffResources: Map<string, { uri: URI; changeType: IChatEditingTextDisplayDiffDto['changeType'] }>,
		uri: URI,
		changeType: IChatEditingTextDisplayDiffDto['changeType']
	): void {
		const key = uri.toString();
		const existing = textDiffResources.get(key);
		if (!existing || existing.changeType === 'modify') {
			textDiffResources.set(key, { uri, changeType });
		}
	}

	private _createTextDisplayDiff(
		uri: URI,
		changeType: IChatEditingTextDisplayDiffDto['changeType'],
		originalUri: URI,
		modifiedUri: URI,
		diff: IEditSessionEntryDiff | undefined
	): IChatEditingTextDisplayDiffDto | undefined {
		if (!diff) {
			return undefined;
		}

		if (diff.identical || diff.changes.length === 0) {
			return undefined;
		}

		return {
			type: 'text',
			uri,
			changeType,
			originalUri,
			modifiedUri,
			hunks: diff.changes.map(change => this._toTextDiffHunk(change))
		};
	}

	private _toTextDiffHunk(change: { original: { startLineNumber: number; endLineNumberExclusive: number }; modified: { startLineNumber: number; endLineNumberExclusive: number } }): IChatEditingTextDiffHunkDto {
		const original = this._toDisplayLineRange(change.original);
		const modified = this._toDisplayLineRange(change.modified);
		const type = original.startLineNumber === original.endLineNumberExclusive
			? 'insert'
			: modified.startLineNumber === modified.endLineNumberExclusive
				? 'delete'
				: 'modify';

		return { type, original, modified };
	}

	private _toDisplayLineRange(range: { startLineNumber: number; endLineNumberExclusive: number }): IChatEditingDisplayLineRangeDto {
		return {
			startLineNumber: range.startLineNumber,
			endLineNumberExclusive: range.endLineNumberExclusive
		};
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
