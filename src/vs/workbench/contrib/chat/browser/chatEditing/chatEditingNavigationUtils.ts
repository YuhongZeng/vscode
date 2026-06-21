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

const rememberedAnchorIndices = new WeakMap<object, { anchorIndex: number; position: Position }>();

export function toChatEditRange(modifiedRange: LineRange): Range | null {
	if (!modifiedRange.isEmpty) {
		return modifiedRange.toInclusiveRange();
	}

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

export function setRememberedChatEditAnchor(owner: object, hunk: IChatEditNavigationHunk): void {
	rememberedAnchorIndices.set(owner, { anchorIndex: hunk.anchorIndex, position: hunk.cursorPosition });
}

export function clearRememberedChatEditAnchor(owner: object): void {
	rememberedAnchorIndices.delete(owner);
}

export function getRememberedChatEditAnchorIndex(owner: object, position: Position): number | undefined {
	const remembered = rememberedAnchorIndices.get(owner);
	return remembered && Position.equals(remembered.position, position) ? remembered.anchorIndex : undefined;
}

export function getChatEditAnchorPositions(hunks: readonly IChatEditNavigationHunk[]): Position[] {
	return hunks.map(hunk => hunk.cursorPosition);
}

function toChatEditCursorPosition(modifiedRange: LineRange, resolver?: ICursorPositionResolver): Position {
	if (!modifiedRange.isEmpty) {
		return new Position(modifiedRange.startLineNumber, 1);
	}

	if (modifiedRange.startLineNumber <= 1) {
		return new Position(1, 1);
	}

	if (resolver && modifiedRange.startLineNumber > resolver.getLineCount()) {
		const lastLineNumber = resolver.getLineCount();
		return new Position(lastLineNumber, resolver.getLineMaxColumn(lastLineNumber));
	}

	return new Position(modifiedRange.startLineNumber, 1);
}

function getRememberedAnchorIndex(hunks: readonly IChatEditNavigationHunk[], position: Position, owner: object | undefined, matchingIndices: readonly number[]): number | undefined {
	if (!owner) {
		return undefined;
	}

	const rememberedAnchorIndex = getRememberedChatEditAnchorIndex(owner, position);
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

export function getChatEditOverlayActiveIndex(hunks: readonly IChatEditNavigationHunk[], position: Position, owner?: object): number {
	if (hunks.length === 0) {
		return -1;
	}

	const matchingIndices = getMatchingAnchorIndices(hunks, position);
	if (matchingIndices.length > 0) {
		return getRememberedAnchorIndex(hunks, position, owner, matchingIndices) ?? matchingIndices[matchingIndices.length - 1];
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
