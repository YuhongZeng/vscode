/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../base/common/event.js';
import { constObservable } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { LineRange } from '../../../../editor/common/core/ranges/lineRange.js';
import { DetailedLineRangeMapping } from '../../../../editor/common/diff/rangeMapping.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IChatEditingDisplayDiffDto, IWorkspaceEditDto } from '../../common/extHost.protocol.js';
import { MainThreadChatEditing } from '../../browser/mainThreadChatEditing.js';
import { SingleProxyRPCProtocol } from '../common/testRPCProtocol.js';
import { IChatEditingService, IChatEditingSession } from '../../../contrib/chat/common/editing/chatEditingService.js';
import { IChatService } from '../../../contrib/chat/common/chatService/chatService.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IFilesConfigurationService } from '../../../services/filesConfiguration/common/filesConfigurationService.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { FileSystemProviderErrorCode, createFileSystemProviderError } from '../../../../platform/files/common/files.js';

suite('MainThreadChatEditing', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	type MainThreadChatEditingTestAccess = MainThreadChatEditing & {
		_computeDisplayDiff(session: IChatEditingSession, editDto: IWorkspaceEditDto, requestId: string): Promise<IChatEditingDisplayDiffDto[]>;
		_sessions: { set(handle: number, session: IChatEditingSession): void; get(handle: number): IChatEditingSession | undefined };
		_sessionDisposables: { size: number };
	};

	test('compute display diff reuses stop-based IDE diff result for per-apply snapshot hunks', async () => {
		const modifiedUri = URI.parse('file:///workspace/modified.ts');
		const beforeSnapshotUri = URI.parse('chat-editing-snapshot:///workspace/modified.ts?stop=before');
		const afterSnapshotUri = URI.parse('chat-editing-snapshot:///workspace/modified.ts?stop=after');
		const createdUri = URI.parse('file:///workspace/created.ts');
		const deletedUri = URI.parse('file:///workspace/deleted.ts');
		const renameFromUri = URI.parse('file:///workspace/rename-from.ts');
		const renameToUri = URI.parse('file:///workspace/rename-to.ts');
		const requestId = 'request-1';

		const mainThreadChatEditing = new MainThreadChatEditing(
			SingleProxyRPCProtocol({}),
			new class extends mock<IChatEditingService>() { },
			new class extends mock<IChatService>() {
				override onDidPerformUserAction = Event.None;
			},
			new class extends mock<IUriIdentityService>() { },
			new class extends mock<ITextFileService>() { },
			new class extends mock<IFilesConfigurationService>() { },
			new class extends mock<IExtensionService>() { }
		);

		const session = {
			getSnapshotUri(snapshotRequestId: string, uri: URI, stopId: string | undefined) {
				assert.strictEqual(snapshotRequestId, requestId);
				if (uri.toString() !== modifiedUri.toString()) {
					return undefined;
				}
				if (stopId === 'chatEditingApplyEditsBefore') {
					return beforeSnapshotUri;
				}
				if (stopId === 'chatEditingApplyEditsAfter') {
					return afterSnapshotUri;
				}
				return undefined;
			},
			getEntryDiffBetweenStops(uri: URI, snapshotRequestId: string, stopId: string | undefined) {
				assert.strictEqual(uri.toString(), modifiedUri.toString());
				assert.strictEqual(snapshotRequestId, requestId);
				assert.strictEqual(stopId, 'chatEditingApplyEditsBefore');
				return constObservable({
					originalURI: beforeSnapshotUri,
					modifiedURI: afterSnapshotUri,
					changes: [
						new DetailedLineRangeMapping(new LineRange(8, 10), new LineRange(8, 11), undefined)
					],
					identical: false,
					isFinal: true,
					quitEarly: false,
					added: 3,
					removed: 2,
					isBusy: false
				});
			}
		} as unknown as IChatEditingSession;

		const editDto: IWorkspaceEditDto = {
			edits: [
				{
					resource: modifiedUri,
					textEdit: {
						range: { startLineNumber: 2, startColumn: 1, endLineNumber: 5, endColumn: 1 },
						text: 'updated'
					},
					versionId: 1
				},
				{ newResource: createdUri },
				{ oldResource: deletedUri },
				{ oldResource: renameFromUri, newResource: renameToUri }
			]
		};

		const result = await (mainThreadChatEditing as MainThreadChatEditingTestAccess)._computeDisplayDiff(session, editDto, requestId);

		assert.deepStrictEqual(result, [
			{ type: 'create', uri: createdUri },
			{ type: 'delete', uri: deletedUri },
			{ type: 'rename', oldUri: renameFromUri, newUri: renameToUri },
			{
				type: 'text',
				uri: modifiedUri,
				changeType: 'modify',
				originalUri: beforeSnapshotUri,
				modifiedUri: afterSnapshotUri,
				hunks: [{
					type: 'modify',
					original: { startLineNumber: 8, endLineNumberExclusive: 10 },
					modified: { startLineNumber: 8, endLineNumberExclusive: 11 }
				}]
			}
		]);

		mainThreadChatEditing.dispose();
	});

	test('compute display diff keeps merged hunk from IDE when short unchanged lines are folded into one hunk', async () => {
		const modifiedUri = URI.parse('file:///workspace/merged.ts');
		const beforeSnapshotUri = URI.parse('chat-editing-snapshot:///workspace/merged.ts?stop=before');
		const afterSnapshotUri = URI.parse('chat-editing-snapshot:///workspace/merged.ts?stop=after');
		const requestId = 'request-merged';

		const mainThreadChatEditing = new MainThreadChatEditing(
			SingleProxyRPCProtocol({}),
			new class extends mock<IChatEditingService>() { },
			new class extends mock<IChatService>() {
				override onDidPerformUserAction = Event.None;
			},
			new class extends mock<IUriIdentityService>() { },
			new class extends mock<ITextFileService>() { },
			new class extends mock<IFilesConfigurationService>() { },
			new class extends mock<IExtensionService>() { }
		);

		const session = {
			getSnapshotUri(snapshotRequestId: string, uri: URI, stopId: string | undefined) {
				assert.strictEqual(snapshotRequestId, requestId);
				assert.strictEqual(uri.toString(), modifiedUri.toString());
				return stopId === 'chatEditingApplyEditsBefore' ? beforeSnapshotUri : afterSnapshotUri;
			},
			getEntryDiffBetweenStops(uri: URI, snapshotRequestId: string, stopId: string | undefined) {
				assert.strictEqual(uri.toString(), modifiedUri.toString());
				assert.strictEqual(snapshotRequestId, requestId);
				assert.strictEqual(stopId, 'chatEditingApplyEditsBefore');
				return constObservable({
					originalURI: beforeSnapshotUri,
					modifiedURI: afterSnapshotUri,
					changes: [
						new DetailedLineRangeMapping(new LineRange(4, 9), new LineRange(4, 10), undefined)
					],
					identical: false,
					isFinal: true,
					quitEarly: false,
					added: 6,
					removed: 5,
					isBusy: false
				});
			}
		} as unknown as IChatEditingSession;

		const editDto: IWorkspaceEditDto = {
			edits: [
				{
					resource: modifiedUri,
					textEdit: {
						range: { startLineNumber: 4, startColumn: 1, endLineNumber: 5, endColumn: 1 },
						text: 'first\n'
					},
					versionId: 1
				},
				{
					resource: modifiedUri,
					textEdit: {
						range: { startLineNumber: 7, startColumn: 1, endLineNumber: 8, endColumn: 1 },
						text: 'second\nthird\n'
					},
					versionId: 1
				}
			]
		};

		const result = await (mainThreadChatEditing as MainThreadChatEditingTestAccess)._computeDisplayDiff(session, editDto, requestId);

		assert.deepStrictEqual(result, [
			{
				type: 'text',
				uri: modifiedUri,
				changeType: 'modify',
				originalUri: beforeSnapshotUri,
				modifiedUri: afterSnapshotUri,
				hunks: [{
					type: 'modify',
					original: { startLineNumber: 4, endLineNumberExclusive: 9 },
					modified: { startLineNumber: 4, endLineNumberExclusive: 10 }
				}]
			}
		]);

		mainThreadChatEditing.dispose();
	});

	test('applyEdits succeeds for create-only workspace edits without explicit save', async () => {
		const createdUri = URI.parse('file:///workspace/empty.ts');
		const chatSessionResource = URI.parse('chat:///session');
		let applyWorkspaceEditCalled = false;
		let responseCompleted = false;

		const mainThreadChatEditing = new MainThreadChatEditing(
			SingleProxyRPCProtocol({}),
			new class extends mock<IChatEditingService>() { },
			new class extends mock<IChatService>() {
				override onDidPerformUserAction = Event.None;
				override getSession(resource: URI) {
					assert.strictEqual(resource.toString(), chatSessionResource.toString());
					return {
						addRequest() {
							return {
								id: 'request-create',
								response: {
									complete() {
										responseCompleted = true;
									}
								}
							};
						}
					};
				}
			},
			new class extends mock<IUriIdentityService>() { },
			new class extends mock<ITextFileService>() {
				override async save(): Promise<undefined> {
					assert.fail('create-only edits should not require an explicit text file save');
				}
			},
			new class extends mock<IFilesConfigurationService>() {
				override isReadonly(): boolean {
					return false;
				}
			},
			new class extends mock<IExtensionService>() { }
		);

		(mainThreadChatEditing as MainThreadChatEditingTestAccess)._sessions.set(1, {
			chatSessionResource,
			createSnapshot() { },
			async applyWorkspaceEdit(edit: { edits: { newResource?: URI }[] }) {
				applyWorkspaceEditCalled = true;
				assert.strictEqual(edit.edits.length, 1);
				assert.strictEqual(edit.edits[0].newResource?.toString(), createdUri.toString());
			},
			getSnapshotUri() {
				return undefined;
			},
			dispose() { }
		} as unknown as IChatEditingSession);

		const editDto: IWorkspaceEditDto = {
			edits: [{ newResource: createdUri }]
		};

		const result = await mainThreadChatEditing.$applyEdits(1, editDto, 'create empty file');

		assert.strictEqual(applyWorkspaceEditCalled, true);
		assert.strictEqual(responseCompleted, true);
		assert.strictEqual(result.success, true);
		assert.deepStrictEqual(result.displayDiff, [{ type: 'create', uri: createdUri }]);

		mainThreadChatEditing.dispose();
	});

	test('applyEdits creates the after snapshot after all streaming edits settle', async () => {
		const firstUri = URI.parse('file:///workspace/first.ts');
		const secondUri = URI.parse('file:///workspace/second.ts');
		const chatSessionResource = URI.parse('chat:///session');
		const snapshotEvents: string[] = [];
		const completionOptions: ({ createSnapshot?: boolean } | undefined)[] = [];
		let releaseFirst!: () => void;
		let releaseSecond!: () => void;

		const mainThreadChatEditing = new MainThreadChatEditing(
			SingleProxyRPCProtocol({}),
			new class extends mock<IChatEditingService>() { },
			new class extends mock<IChatService>() {
				override onDidPerformUserAction = Event.None;
				override getSession(resource: URI) {
					assert.strictEqual(resource.toString(), chatSessionResource.toString());
					return {
						addRequest() {
							return {
								id: 'request-multi',
								response: {
									complete() { }
								}
							};
						}
					};
				}
			},
			new class extends mock<IUriIdentityService>() { },
			new class extends mock<ITextFileService>() {
				override async save(): Promise<URI> {
					return firstUri;
				}
			},
			new class extends mock<IFilesConfigurationService>() {
				override isReadonly(): boolean {
					return false;
				}
			},
			new class extends mock<IExtensionService>() { }
		);

		(mainThreadChatEditing as MainThreadChatEditingTestAccess)._sessions.set(1, {
			chatSessionResource,
			createSnapshot(_requestId: string, stopId: string | undefined) {
				snapshotEvents.push(stopId ?? 'request');
			},
			startStreamingEdits(uri: URI) {
				return {
					pushText() { },
					complete(options?: { createSnapshot?: boolean }) {
						completionOptions.push(options);
						return new Promise<void>(resolve => {
							if (uri.toString() === firstUri.toString()) {
								releaseFirst = resolve;
							} else {
								releaseSecond = resolve;
							}
						});
					}
				};
			},
			getSnapshotUri() {
				return undefined;
			},
			dispose() { }
		} as unknown as IChatEditingSession);

		const resultPromise = mainThreadChatEditing.$applyEdits(1, {
			edits: [
				{
					resource: firstUri,
					textEdit: {
						range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
						text: 'first'
					},
					versionId: 1
				},
				{
					resource: secondUri,
					textEdit: {
						range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
						text: 'second'
					},
					versionId: 1
				}
			]
		}, 'multi edit');

		await new Promise(resolve => setTimeout(resolve, 0));
		assert.deepStrictEqual(snapshotEvents, ['chatEditingApplyEditsBefore']);
		assert.deepStrictEqual(completionOptions, [{ createSnapshot: false }, { createSnapshot: false }]);

		releaseFirst();
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.deepStrictEqual(snapshotEvents, ['chatEditingApplyEditsBefore']);

		releaseSecond();
		const result = await resultPromise;

		assert.strictEqual(result.success, true);
		assert.deepStrictEqual(snapshotEvents, ['chatEditingApplyEditsBefore', 'chatEditingApplyEditsAfter']);

		mainThreadChatEditing.dispose();
	});

	test('applyEdits retries Windows transient save errors and succeeds once save recovers', async () => {
		const targetUri = URI.parse('file:///workspace/retry-success.ts');
		const chatSessionResource = URI.parse('chat:///session-retry-success');
		let saveAttempts = 0;
		let responseCompleted = false;

		const mainThreadChatEditing = new MainThreadChatEditing(
			SingleProxyRPCProtocol({}),
			new class extends mock<IChatEditingService>() { },
			new class extends mock<IChatService>() {
				override onDidPerformUserAction = Event.None;
				override getSession(resource: URI) {
					assert.strictEqual(resource.toString(), chatSessionResource.toString());
					return {
						addRequest() {
							return {
								id: 'request-retry-success',
								response: {
									complete() {
										responseCompleted = true;
									}
								}
							};
						}
					};
				}
			},
			new class extends mock<IUriIdentityService>() { },
			new class extends mock<ITextFileService>() {
				override async save(): Promise<URI> {
					saveAttempts++;
					if (saveAttempts < 3) {
						throw Object.assign(
							new Error(`EPERM: operation not permitted, open '${targetUri.fsPath}' (sharing violation)`),
							{ code: 'EPERM' }
						);
					}

					return targetUri;
				}
			},
			new class extends mock<IFilesConfigurationService>() {
				override isReadonly(): boolean {
					return false;
				}
			},
			new class extends mock<IExtensionService>() { }
		);

		(mainThreadChatEditing as MainThreadChatEditingTestAccess)._sessions.set(1, {
			chatSessionResource,
			createSnapshot() { },
			startStreamingEdits() {
				return {
					pushText() { },
					complete() {
						return Promise.resolve();
					}
				};
			},
			async reject() {
				assert.fail('successful retry path must not reject edits');
			},
			getSnapshotUri() {
				return undefined;
			},
			dispose() { }
		} as unknown as IChatEditingSession);

		const result = await mainThreadChatEditing.$applyEdits(1, {
			edits: [{
				resource: targetUri,
				textEdit: {
					range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
					text: 'retry success'
				},
				versionId: 1
			}]
		}, 'retry save');

		assert.strictEqual(saveAttempts, 3);
		assert.strictEqual(responseCompleted, true);
		assert.strictEqual(result.success, true);
		assert.deepStrictEqual(result.failedEdits, undefined);

		mainThreadChatEditing.dispose();
	});

	test('applyEdits retries Windows transient save errors a bounded number of times before rejecting failed edits', async () => {
		const targetUri = URI.parse('file:///workspace/retry-failed.ts');
		const chatSessionResource = URI.parse('chat:///session-retry-failed');
		let saveAttempts = 0;
		let rejectCalledWithApiFlag = false;
		let rejectedUris: URI[] = [];
		const sessionStub: { isAcceptingFromApi?: boolean } = {};

		const mainThreadChatEditing = new MainThreadChatEditing(
			SingleProxyRPCProtocol({}),
			new class extends mock<IChatEditingService>() { },
			new class extends mock<IChatService>() {
				override onDidPerformUserAction = Event.None;
				override getSession(resource: URI) {
					assert.strictEqual(resource.toString(), chatSessionResource.toString());
					return {
						addRequest() {
							return {
								id: 'request-retry-failed',
								response: {
									complete() { }
								}
							};
						}
					};
				}
			},
			new class extends mock<IUriIdentityService>() { },
			new class extends mock<ITextFileService>() {
				override async save(): Promise<URI> {
					saveAttempts++;
					throw Object.assign(
						new Error(`EPERM: operation not permitted, open '${targetUri.fsPath}' (sharing violation)`),
						{ code: 'EPERM' }
					);
				}
			},
			new class extends mock<IFilesConfigurationService>() {
				override isReadonly(): boolean {
					return false;
				}
			},
			new class extends mock<IExtensionService>() { }
		);

		Object.assign(sessionStub, {
			chatSessionResource,
			createSnapshot() { },
			startStreamingEdits() {
				return {
					pushText() { },
					complete() {
						return Promise.resolve();
					}
				};
			},
			async reject(...uris: URI[]) {
				rejectCalledWithApiFlag = sessionStub.isAcceptingFromApi === true;
				rejectedUris = uris;
			},
			getSnapshotUri() {
				return undefined;
			},
			dispose() { }
		});

		(mainThreadChatEditing as MainThreadChatEditingTestAccess)._sessions.set(1, sessionStub as unknown as IChatEditingSession);

		const result = await mainThreadChatEditing.$applyEdits(1, {
			edits: [{
				resource: targetUri,
				textEdit: {
					range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
					text: 'retry failed'
				},
				versionId: 1
			}]
		}, 'retry save failure');

		assert.strictEqual(saveAttempts, 4);
		assert.strictEqual(rejectCalledWithApiFlag, true);
		assert.deepStrictEqual(rejectedUris, [targetUri]);
		assert.strictEqual(result.success, false);
		assert.strictEqual(result.failedEdits?.length, 1);
		assert.strictEqual(result.failedEdits?.[0].uri.toString(), targetUri.toString());
		assert.ok(result.failedEdits?.[0].reason.includes('Save failed after 4 attempts (3 retries):'));
		assert.ok(result.failedEdits?.[0].reason.includes('sharing violation'));

		mainThreadChatEditing.dispose();
	});

	test('applyEdits retries Windows sharing violations surfaced as EACCES', async () => {
		const targetUri = URI.parse('file:///workspace/retry-eacces.ts');
		const chatSessionResource = URI.parse('chat:///session-retry-eacces');
		let saveAttempts = 0;

		const mainThreadChatEditing = new MainThreadChatEditing(
			SingleProxyRPCProtocol({}),
			new class extends mock<IChatEditingService>() { },
			new class extends mock<IChatService>() {
				override onDidPerformUserAction = Event.None;
				override getSession(resource: URI) {
					assert.strictEqual(resource.toString(), chatSessionResource.toString());
					return {
						addRequest() {
							return {
								id: 'request-retry-eacces',
								response: {
									complete() { }
								}
							};
						}
					};
				}
			},
			new class extends mock<IUriIdentityService>() { },
			new class extends mock<ITextFileService>() {
				override async save(): Promise<URI> {
					saveAttempts++;
					if (saveAttempts < 2) {
						throw Object.assign(
							new Error(`EACCES: permission denied, open '${targetUri.fsPath}' because it is being used by another process`),
							{ code: 'EACCES' }
						);
					}

					return targetUri;
				}
			},
			new class extends mock<IFilesConfigurationService>() {
				override isReadonly(): boolean {
					return false;
				}
			},
			new class extends mock<IExtensionService>() { }
		);

		(mainThreadChatEditing as MainThreadChatEditingTestAccess)._sessions.set(1, {
			chatSessionResource,
			createSnapshot() { },
			startStreamingEdits() {
				return {
					pushText() { },
					complete() {
						return Promise.resolve();
					}
				};
			},
			async reject() {
				assert.fail('Windows transient sharing violation should recover before reject');
			},
			getSnapshotUri() {
				return undefined;
			},
			dispose() { }
		} as unknown as IChatEditingSession);

		const result = await mainThreadChatEditing.$applyEdits(1, {
			edits: [{
				resource: targetUri,
				textEdit: {
					range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
					text: 'retry eacces'
				},
				versionId: 1
			}]
		}, 'retry eacces save');

		assert.strictEqual(saveAttempts, 2);
		assert.strictEqual(result.success, true);
		assert.deepStrictEqual(result.failedEdits, undefined);

		mainThreadChatEditing.dispose();
	});

	test('applyEdits does not retry non-transient save errors', async () => {
		const targetUri = URI.parse('file:///workspace/no-retry.ts');
		const chatSessionResource = URI.parse('chat:///session-no-retry');
		let saveAttempts = 0;
		let rejectedUris: URI[] = [];

		const mainThreadChatEditing = new MainThreadChatEditing(
			SingleProxyRPCProtocol({}),
			new class extends mock<IChatEditingService>() { },
			new class extends mock<IChatService>() {
				override onDidPerformUserAction = Event.None;
				override getSession(resource: URI) {
					assert.strictEqual(resource.toString(), chatSessionResource.toString());
					return {
						addRequest() {
							return {
								id: 'request-no-retry',
								response: {
									complete() { }
								}
							};
						}
					};
				}
			},
			new class extends mock<IUriIdentityService>() { },
			new class extends mock<ITextFileService>() {
				override async save(): Promise<URI> {
					saveAttempts++;
					throw createFileSystemProviderError('no permissions', FileSystemProviderErrorCode.NoPermissions);
				}
			},
			new class extends mock<IFilesConfigurationService>() {
				override isReadonly(): boolean {
					return false;
				}
			},
			new class extends mock<IExtensionService>() { }
		);

		(mainThreadChatEditing as MainThreadChatEditingTestAccess)._sessions.set(1, {
			chatSessionResource,
			createSnapshot() { },
			startStreamingEdits() {
				return {
					pushText() { },
					complete() {
						return Promise.resolve();
					}
				};
			},
			async reject(...uris: URI[]) {
				rejectedUris = uris;
			},
			getSnapshotUri() {
				return undefined;
			},
			dispose() { }
		} as unknown as IChatEditingSession);

		const result = await mainThreadChatEditing.$applyEdits(1, {
			edits: [{
				resource: targetUri,
				textEdit: {
					range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
					text: 'no retry'
				},
				versionId: 1
			}]
		}, 'no retry save failure');

		assert.strictEqual(saveAttempts, 1);
		assert.deepStrictEqual(rejectedUris, [targetUri]);
		assert.strictEqual(result.success, false);
		assert.strictEqual(result.failedEdits?.length, 1);
		assert.ok(result.failedEdits?.[0].reason.includes('no permissions'));

		mainThreadChatEditing.dispose();
	});

	test('notifies ext host and releases session listeners when the underlying session disposes', async () => {
		const disposedHandles: number[] = [];
		const onDidDisposeSession = new Emitter<void>();
		const chatSessionResource = URI.parse('chat:///session-disposed');
		let registeredSession: IChatEditingSession | undefined;

		const mainThreadChatEditing = new MainThreadChatEditing(
			SingleProxyRPCProtocol({
				$onDidUpdateSession() { },
				$onDidDisposeSession(handle: number) {
					disposedHandles.push(handle);
				}
			}),
			new class extends mock<IChatEditingService>() {
				override startOrContinueGlobalEditingSession(): IChatEditingSession {
					registeredSession = {
						chatSessionResource,
						entries: constObservable([]),
						onDidDispose: onDidDisposeSession.event,
						dispose() { },
						stop() { return Promise.resolve(); }
					} as unknown as IChatEditingSession;
					return registeredSession;
				}
			},
			new class extends mock<IChatService>() {
				override onDidPerformUserAction = Event.None;
				override startSession() {
					return {
						object: {},
						dispose() { }
					};
				}
			},
			new class extends mock<IUriIdentityService>() { },
			new class extends mock<ITextFileService>() { },
			new class extends mock<IFilesConfigurationService>() { },
			new class extends mock<IExtensionService>() { }
		);

		const handle = 1;
		await mainThreadChatEditing.$createEditingSession(handle);
		assert.strictEqual((mainThreadChatEditing as MainThreadChatEditingTestAccess)._sessions.get(handle), registeredSession);

		onDidDisposeSession.fire();

		assert.deepStrictEqual(disposedHandles, [handle]);
		assert.strictEqual((mainThreadChatEditing as MainThreadChatEditingTestAccess)._sessions.get(handle), undefined);
		assert.strictEqual((mainThreadChatEditing as MainThreadChatEditingTestAccess)._sessionDisposables.size, 0);

		mainThreadChatEditing.dispose();
		onDidDisposeSession.dispose();
	});
});
