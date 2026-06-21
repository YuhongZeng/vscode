/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { LineRange } from '../../../../../editor/common/core/ranges/lineRange.js';
import { ITextModel } from '../../../../../editor/common/model.js';

export interface IChatEditNavigationHunk {
	readonly anchorIndex: number;
	readonly modifiedRange: LineRange;
	readonly revealRange: Range;
	readonly cursorPosition: Position;
	readonly isDeleteOnly: boolean;
}

type ICursorPositionResolver = Pick<ITextModel, 'getLineCount' | 'getLineMaxColumn'>;

interface IRememberedChatEditAnchor {
	readonly anchorIdentity: string;
	readonly position: Position;
	readonly resourceKey: string | undefined;
}

// Delete-only hunks can collapse onto the same cursor position, so remember
// which synthetic anchor the user most recently navigated to at that location.
// WeakMap keeps this tied to the editor owner lifetime and does not retain
// disposed editors on its own.
const rememberedAnchorIndices = new WeakMap<object, IRememberedChatEditAnchor>();

export function toChatEditRange(modifiedRange: LineRange): Range | null {
	if (!modifiedRange.isEmpty) {
		return modifiedRange.toInclusiveRange();
	}

	// A delete-only hunk has no remaining lines to reveal, so expose the gap that
	// still exists in the editor after the deletion.
	if (modifiedRange.startLineNumber === 1) {
		return new Range(1, 1, 1, 1);
	}

	return new Range(modifiedRange.startLineNumber - 1, 1, modifiedRange.startLineNumber, 1);
}

export function createChatEditNavigationHunks(modifiedRanges: readonly LineRange[], resolver?: ICursorPositionResolver): IChatEditNavigationHunk[] {
	const hunks = modifiedRanges
		.map((modifiedRange, sourceIndex) => {
			const revealRange = toChatEditRange(modifiedRange);
			if (!revealRange) {
				return undefined;
			}

			return {
				sourceIndex,
				modifiedRange,
				revealRange,
				isDeleteOnly: modifiedRange.isEmpty,
				cursorPosition: toChatEditCursorPosition(modifiedRange, resolver),
			};
		})
		.filter((hunk): hunk is {
			sourceIndex: number;
			modifiedRange: LineRange;
			revealRange: Range;
			isDeleteOnly: boolean;
			cursorPosition: Position;
		} => !!hunk);

	hunks.sort((a, b) => {
		const startDelta = a.modifiedRange.startLineNumber - b.modifiedRange.startLineNumber;
		if (startDelta !== 0) {
			return startDelta;
		}

		const endDelta = a.modifiedRange.endLineNumberExclusive - b.modifiedRange.endLineNumberExclusive;
		if (endDelta !== 0) {
			return endDelta;
		}

		return a.sourceIndex - b.sourceIndex;
	});

	return hunks.map((hunk, anchorIndex) => ({
		anchorIndex,
		modifiedRange: hunk.modifiedRange,
		revealRange: hunk.revealRange,
		cursorPosition: hunk.cursorPosition,
		isDeleteOnly: hunk.isDeleteOnly,
	}));
}

export function setRememberedChatEditAnchor(owner: object, hunk: IChatEditNavigationHunk, resourceKey?: string): void {
	rememberedAnchorIndices.set(owner, {
		anchorIdentity: getChatEditAnchorIdentity(hunk),
		position: hunk.cursorPosition,
		resourceKey,
	});
}

export function clearRememberedChatEditAnchor(owner: object): void {
	rememberedAnchorIndices.delete(owner);
}

export function getRememberedChatEditAnchorIndex(owner: object, hunks: readonly IChatEditNavigationHunk[], position: Position, resourceKey?: string): number | undefined {
	const remembered = rememberedAnchorIndices.get(owner);
	if (!remembered || !Position.equals(remembered.position, position) || remembered.resourceKey !== resourceKey) {
		return undefined;
	}

	for (const hunk of hunks) {
		if (Position.equals(hunk.cursorPosition, position) && getChatEditAnchorIdentity(hunk) === remembered.anchorIdentity) {
			return hunk.anchorIndex;
		}
	}

	return undefined;
}

export function getChatEditAnchorPositions(hunks: readonly IChatEditNavigationHunk[]): Position[] {
	return hunks.map(hunk => hunk.cursorPosition);
}

function toChatEditCursorPosition(modifiedRange: LineRange, resolver?: ICursorPositionResolver): Position {
	if (!modifiedRange.isEmpty) {
		return new Position(modifiedRange.startLineNumber, 1);
	}

	// Keep deletions navigable by anchoring them to a stable cursor position even
	// though the deleted lines no longer exist in the modified document.
	if (modifiedRange.startLineNumber <= 1) {
		return new Position(1, 1);
	}

	if (resolver && modifiedRange.startLineNumber > resolver.getLineCount()) {
		const lastLineNumber = resolver.getLineCount();
		return new Position(lastLineNumber, resolver.getLineMaxColumn(lastLineNumber));
	}

	return new Position(modifiedRange.startLineNumber, 1);
}

function getChatEditAnchorIdentity(hunk: IChatEditNavigationHunk): string {
	const { modifiedRange, revealRange, cursorPosition, isDeleteOnly } = hunk;
	return [
		modifiedRange.startLineNumber,
		modifiedRange.endLineNumberExclusive,
		revealRange.startLineNumber,
		revealRange.startColumn,
		revealRange.endLineNumber,
		revealRange.endColumn,
		cursorPosition.lineNumber,
		cursorPosition.column,
		isDeleteOnly ? 1 : 0,
	].join(':');
}

function getRememberedAnchorIndex(hunks: readonly IChatEditNavigationHunk[], position: Position, owner: object | undefined, matchingIndices: readonly number[], resourceKey?: string): number | undefined {
	if (!owner) {
		return undefined;
	}

	const rememberedAnchorIndex = getRememberedChatEditAnchorIndex(owner, hunks, position, resourceKey);
	if (rememberedAnchorIndex === undefined) {
		return undefined;
	}

	return matchingIndices.includes(rememberedAnchorIndex) ? rememberedAnchorIndex : undefined;
}

function getMatchingAnchorIndices(hunks: readonly IChatEditNavigationHunk[], position: Position): number[] {
	const matchingIndices: number[] = [];

	for (const hunk of hunks) {
		if (Position.equals(hunk.cursorPosition, position)) {
			matchingIndices.push(hunk.anchorIndex);
		}
	}

	return matchingIndices;
}

export function getChatEditOverlayActiveIndex(hunks: readonly IChatEditNavigationHunk[], position: Position, owner?: object, resourceKey?: string): number {
	if (hunks.length === 0) {
		return -1;
	}

	const matchingIndices = getMatchingAnchorIndices(hunks, position);
	if (matchingIndices.length > 0) {
		// Multiple delete-only hunks may share one anchor position. Prefer the last
		// remembered anchor there so the overlay stays on the hunk the user picked.
		return getRememberedAnchorIndex(hunks, position, owner, matchingIndices, resourceKey) ?? matchingIndices[matchingIndices.length - 1];
	}

	let containingIndex = -1;

	for (const hunk of hunks) {
		if (!hunk.isDeleteOnly && hunk.revealRange.containsPosition(position)) {
			containingIndex = hunk.anchorIndex;
			continue;
		}

		if (Position.isBefore(position, hunk.cursorPosition)) {
			return containingIndex !== -1 ? containingIndex : hunk.anchorIndex;
		}
	}

	return containingIndex !== -1 ? containingIndex : hunks.length - 1;
}
