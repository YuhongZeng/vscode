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
			/**
			 * A list of files that failed to apply or save.
			 */
			readonly failedEdits?: { readonly uri: Uri; readonly reason: string }[];
		}

		export enum ChatEditingSessionUserAction {
			FileAccepted = 1,
			FileRejected = 2,
			HunkAccepted = 3,
			HunkRejected = 4
		}

		export interface ChatEditingSessionAction {
			readonly type: ChatEditingSessionUserAction;
			readonly uri: Uri;
			/**
			 * Indicates whether this action was triggered by an extension calling the API (true)
			 * or by a user interacting with the UI (false).
			 */
			readonly isFromApi?: boolean;
			/**
			 * The state of the file after the action was applied.
			 */
			readonly file: ChatEditingFile;
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
			 * Fired when a user action (accept or reject) happens on a hunk or a file in the UI.
			 */
			// eslint-disable-next-line local/vscode-dts-event-naming
			readonly onDidUserAction: Event<ChatEditingSessionAction>;

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
		 * Fired when a user action happens on a session that has not yet been claimed by the extension.
		 */
		// eslint-disable-next-line local/vscode-dts-event-naming
		export const onDidUnclaimedUserAction: Event<{ readonly chatSessionId: string }>;

		/**
		 * Start a new editing session.
		 */
		export function startEditingSession(options?: ChatEditingSessionOptions): Thenable<ChatEditingSession>;

		/**
		 * Controls the visibility of chat editing diffs in the editor.
		 * Diffs are hidden by default to prevent flashing before the extension is fully activated.
		 * @param visible Whether the editor diffs should be visible.
		 */
		export function setEditingEditorVisibility(visible: boolean): void;
	}
}
