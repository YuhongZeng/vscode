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

		/**
		 * Represents the kind of a chat edit.
		 */
		export enum ChatEditKind {
			Created = 0,
			Modified = 1,
			Deleted = 2
		}

		export interface ChatEditingFile {
			readonly uri: Uri;
			readonly state: ChatEditingFileState;
			readonly kind: ChatEditKind;
			readonly added: number;
			readonly removed: number;
		}

		export interface ChatEditingLineRange {
			readonly startLineNumber: number;
			readonly endLineNumberExclusive: number;
		}

		export interface ChatEditingTextDiffHunk {
			readonly kind: ChatEditKind;
			readonly original: ChatEditingLineRange;
			readonly modified: ChatEditingLineRange;
		}

		export interface ChatEditingTextDiff {
			readonly uri: Uri;
			readonly kind: ChatEditKind;
			/**
			 * A snapshot URI representing the file immediately before this `applyEdits` call.
			 */
			readonly originalUri: Uri;
			/**
			 * A snapshot URI representing the file immediately after this `applyEdits` call.
			 */
			readonly modifiedUri: Uri;
			readonly hunks: readonly ChatEditingTextDiffHunk[];
		}

		export interface ChatEditingCreateFileDiff {
			readonly uri: Uri;
			readonly kind: ChatEditKind.Created;
		}

		export interface ChatEditingDeleteFileDiff {
			readonly uri: Uri;
			readonly kind: ChatEditKind.Deleted;
		}

		export interface ChatEditingRenameFileDiff {
			readonly oldUri: Uri;
			readonly newUri: Uri;
		}

		export type ChatEditingDisplayDiff = ChatEditingTextDiff | ChatEditingCreateFileDiff | ChatEditingDeleteFileDiff | ChatEditingRenameFileDiff;

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
			/**
			 * The display diff for this `applyEdits` call as computed by the IDE for the editor UI.
			 * This compares snapshots taken immediately before and after the apply, so it does not
			 * accumulate diffs from earlier edits in the same session. Text content is omitted and
			 * only file operations plus text hunk ranges are included.
			 */
			readonly displayDiff: readonly ChatEditingDisplayDiff[];
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
