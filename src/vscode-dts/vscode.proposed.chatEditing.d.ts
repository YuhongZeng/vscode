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
			readonly isNew: boolean;
			readonly added: number;
			readonly removed: number;
		}

		/**
		 * Represents the result of applying edits to a chat editing session.
		 */
		export interface ChatEditingSessionApplyEditsResult {
			/**
			 * Whether the edits were successfully applied.
			 */
			readonly success: boolean;
			/**
			 * The error message if the edits failed to apply.
			 */
			readonly errorMessage?: string;
		}

		export interface ChatEditingSession extends Disposable {
			readonly id: string;
			/**
			 * The list of files modified in this session.
			 */
			readonly files: readonly ChatEditingFile[];

			/**
			 * Fired when the session changes (files added, state changed).
			 */
			readonly onDidChange: Event<void>;

			/**
			 * Fired when the session is disposed.
			 */
			readonly onDidDispose: Event<void>;

			/**
			 * Apply edits to the session.
			 * This will trigger the diff view in the editor.
			 */
			applyEdits(edit: WorkspaceEdit, description?: string): Thenable<ChatEditingSessionApplyEditsResult>;

			/**
			/**
			 * Accept all changes in the session, or specific files.
			 */
			accept(uris?: Uri[]): Thenable<void>;

			/**
			 * Reject all changes in the session, or specific files.
			 */
			reject(uris?: Uri[]): Thenable<void>;

			/**
			 * Show the multi-file diff editor for the changes in this session.
			 * @param title The title of the session to display in the editor.
			 */
			show(title?: string): Thenable<void>;
		}

		export interface ChatEditingSessionOptions {
			chatSessionId?: string;
		}

		/**
		 * Start a new editing session.
		 */
		export function startEditingSession(options?: ChatEditingSessionOptions): Thenable<ChatEditingSession>;
	}
}
