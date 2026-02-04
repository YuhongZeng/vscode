/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	export namespace chat {

		/**
		 * Represents the state of a file in a chat editing session.
		 */
		export enum ChatEditingFileState {
			Modified = 0,
			Accepted = 1,
			Rejected = 2
		}

		export interface ChatEditingFile {
			readonly uri: Uri;
			readonly state: ChatEditingFileState;
			readonly added: number;
			readonly removed: number;
		}

		export interface ChatEditingSession extends Disposable {
			/**
			 * The list of files modified in this session.
			 */
			readonly files: readonly ChatEditingFile[];

			/**
			 * Fired when the session changes (files added, state changed).
			 */
			readonly onDidChange: Event<void>;

			/**
			 * Apply edits to the session.
			 * This will trigger the diff view in the editor.
			 */
			applyEdits(edit: WorkspaceEdit, description?: string): Thenable<void>;

			/**
			 * Accept all changes in the session.
			 */
			accept(): Thenable<void>;

			/**
			 * Reject all changes in the session.
			 */
			reject(): Thenable<void>;
		}

		/**
		 * Create a new editing session.
		 */
		export function createEditingSession(): Thenable<ChatEditingSession>;
	}
}
