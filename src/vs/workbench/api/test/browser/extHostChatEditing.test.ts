/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IApplyEditsResultDto, IWorkspaceEditDto, MainContext, MainThreadChatEditingShape } from '../../common/extHost.protocol.js';
import { ExtHostChatEditing } from '../../common/extHostChatEditing.js';
import * as types from '../../common/extHostTypes.js';
import { TestRPCProtocol } from '../common/testRPCProtocol.js';
import type * as vscode from 'vscode';

suite('ExtHostChatEditing', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('applyEdits returns per-apply snapshot display diff without text content', async () => {
		const rpcProtocol = new TestRPCProtocol();
		const fileUri = URI.parse('file:///workspace/file.ts');
		const beforeSnapshotUri = URI.parse('chat-editing-snapshot:///workspace/file.ts?stop=before');
		const afterSnapshotUri = URI.parse('chat-editing-snapshot:///workspace/file.ts?stop=after');
		const oldUri = URI.parse('file:///workspace/old.ts');
		const newUri = URI.parse('file:///workspace/new.ts');
		const createdUri = URI.parse('file:///workspace/created.ts');
		const deletedUri = URI.parse('file:///workspace/deleted.ts');

		rpcProtocol.set(MainContext.MainThreadChatEditing, new class extends mock<MainThreadChatEditingShape>() {
			override async $createEditingSession(_handle: number): Promise<string> {
				return 'chat-session';
			}

			override async $applyEdits(_handle: number, _edits: IWorkspaceEditDto, _description?: string): Promise<IApplyEditsResultDto> {
				return {
					success: true,
					displayDiff: [
						{ type: 'create', uri: createdUri },
						{ type: 'delete', uri: deletedUri },
						{ type: 'rename', oldUri, newUri },
						{
							type: 'text',
							uri: fileUri,
							changeType: 'modify',
							originalUri: beforeSnapshotUri,
							modifiedUri: afterSnapshotUri,
							hunks: [{
								type: 'modify',
								original: { startLineNumber: 3, endLineNumberExclusive: 5 },
								modified: { startLineNumber: 3, endLineNumberExclusive: 6 }
							}]
						}
					]
				};
			}

			override async $disposeEditingSession(): Promise<void> { }
			override async $accept(): Promise<void> { }
			override async $reject(): Promise<void> { }
			override async $show(): Promise<void> { }
			override async $setEditingEditorVisibility(): Promise<void> { }
		});

		const extHostChatEditing = new ExtHostChatEditing(rpcProtocol);
		const session = await extHostChatEditing.startEditingSession();
		const result = await session.applyEdits(new types.WorkspaceEdit());

		assert.deepStrictEqual(result.displayDiff, [
			{ uri: createdUri, kind: types.ChatEditKind.Created },
			{ uri: deletedUri, kind: types.ChatEditKind.Deleted },
			{ oldUri, newUri },
			{
				uri: fileUri,
				kind: types.ChatEditKind.Modified,
				originalUri: beforeSnapshotUri,
				modifiedUri: afterSnapshotUri,
				hunks: [{
					kind: types.ChatEditKind.Modified,
					original: { startLineNumber: 3, endLineNumberExclusive: 5 },
					modified: { startLineNumber: 3, endLineNumberExclusive: 6 }
				}]
			}
		]);
		const textDiff = result.displayDiff.find((item): item is vscode.chat.ChatEditingTextDiff => 'hunks' in item);
		assert.ok(textDiff);
		const hunk = textDiff.hunks[0]! as vscode.chat.ChatEditingTextDiffHunk & { originalText?: string; modifiedText?: string };
		assert.strictEqual(hunk.originalText, undefined);
		assert.strictEqual(hunk.modifiedText, undefined);
	});

	test('disposed session is removed from ext host session map', async () => {
		const rpcProtocol = new TestRPCProtocol();
		const disposedHandles: number[] = [];

		rpcProtocol.set(MainContext.MainThreadChatEditing, new class extends mock<MainThreadChatEditingShape>() {
			override async $createEditingSession(_handle: number): Promise<string> {
				return 'chat-session';
			}

			override async $disposeEditingSession(handle: number): Promise<void> {
				disposedHandles.push(handle);
			}
		});

		const extHostChatEditing = new ExtHostChatEditing(rpcProtocol);
		const session = await extHostChatEditing.startEditingSession();
		session.dispose();
		session.dispose();

		assert.deepStrictEqual(disposedHandles, [1]);
		assert.strictEqual((extHostChatEditing as unknown as { _sessions: Map<number, unknown> })._sessions.size, 0);
	});

	test('pending session user actions are bounded until a listener is added', async () => {
		const rpcProtocol = new TestRPCProtocol();

		rpcProtocol.set(MainContext.MainThreadChatEditing, new class extends mock<MainThreadChatEditingShape>() {
			override async $createEditingSession(_handle: number): Promise<string> {
				return 'chat-session';
			}
		});

		const extHostChatEditing = new ExtHostChatEditing(rpcProtocol);
		const session = await extHostChatEditing.startEditingSession();

		for (let i = 0; i < 105; i++) {
			extHostChatEditing.$onDidUserAction(1, {
				type: 1,
				uri: URI.parse(`file:///workspace/file-${i}.ts`),
				file: {
					uri: URI.parse(`file:///workspace/file-${i}.ts`),
					state: 0,
					kind: 1,
					added: 1,
					removed: 0
				}
			});
		}

		const actions: vscode.chat.ChatEditingSessionAction[] = [];
		session.onDidUserAction(action => actions.push(action));

		assert.strictEqual(actions.length, 100);
		assert.strictEqual(actions[0].uri.toString(), 'file:///workspace/file-5.ts');
	});

	test('unclaimed session ids are cleared when the last listener is removed', () => {
		const rpcProtocol = new TestRPCProtocol();
		rpcProtocol.set(MainContext.MainThreadChatEditing, new class extends mock<MainThreadChatEditingShape>() { });

		const extHostChatEditing = new ExtHostChatEditing(rpcProtocol);
		const listener = extHostChatEditing.onDidUnclaimedUserAction(() => undefined);
		extHostChatEditing.$onDidUnclaimedUserAction('chat-session');

		assert.strictEqual((extHostChatEditing as unknown as { _unclaimedSessionIds: Set<string> })._unclaimedSessionIds.size, 1);

		listener.dispose();

		assert.strictEqual((extHostChatEditing as unknown as { _unclaimedSessionIds: Set<string> })._unclaimedSessionIds.size, 0);
	});
});
