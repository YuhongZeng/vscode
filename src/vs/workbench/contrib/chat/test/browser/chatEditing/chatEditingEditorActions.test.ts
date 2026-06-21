/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { Position } from '../../../../../../editor/common/core/position.js';
import { getChatEditNavigationTarget } from '../../../browser/chatEditing/chatEditingEditorActions.js';
import { LineRange } from '../../../../../../editor/common/core/ranges/lineRange.js';
import { createChatEditNavigationHunks, getChatEditAnchorPositions, setRememberedChatEditAnchor } from '../../../browser/chatEditing/chatEditingNavigationUtils.js';

suite('ChatEditingEditorActions', function () {
	ensureNoDisposablesAreLeakedInTestSuite();

	function createDeleteOnlyHunks(startLineNumbers: readonly number[], lineCount?: number) {
		return createChatEditNavigationHunks(
			startLineNumbers.map(startLineNumber => new LineRange(startLineNumber, startLineNumber)),
			lineCount === undefined ? undefined : {
				getLineCount: () => lineCount,
				getLineMaxColumn: () => 5,
			}
		);
	}

	function navigateToAnchor(startLineNumbers: readonly number[], position: Position, next: boolean, owner?: object, lineCount?: number): string | undefined {
		const hunks = createDeleteOnlyHunks(startLineNumbers, lineCount);
		const targetIndex = getChatEditNavigationTarget(hunks, position, next, owner);
		if (targetIndex === undefined) {
			return undefined;
		}
		if (owner) {
			setRememberedChatEditAnchor(owner, hunks[targetIndex]);
		}
		return getChatEditAnchorPositions(hunks)[targetIndex].toString();
	}

	test('next navigation advances across logical delete-only gap anchors', function () {
		assert.deepStrictEqual([
			navigateToAnchor([8, 9, 10], new Position(7, 1), true),
			navigateToAnchor([8, 9, 10], new Position(8, 1), true),
			navigateToAnchor([8, 9, 10], new Position(9, 1), true),
		], [
			'(8,1)',
			'(9,1)',
			'(10,1)',
		]);
	});

	test('previous navigation uses logical anchor order instead of synthetic delete ranges', function () {
		assert.deepStrictEqual([
			navigateToAnchor([8, 9, 10], new Position(8, 1), false),
			navigateToAnchor([8, 9, 10], new Position(9, 1), false),
		], [
			'(10,1)',
			'(8,1)',
		]);
	});

	test('repeated navigation stays stable when multiple delete-only anchors map to the same cursor position', function () {
		const owner = {};
		assert.deepStrictEqual([
			navigateToAnchor([1, 2, 4, 5], new Position(2, 2), true, owner, 3),
			navigateToAnchor([1, 2, 4, 5], new Position(3, 5), true, owner, 3),
			navigateToAnchor([1, 2, 4, 5], new Position(3, 5), true, owner, 3),
			navigateToAnchor([1, 2, 4, 5], new Position(3, 5), false, owner, 3),
		], [
			'(3,5)',
			'(3,5)',
			'(1,1)',
			'(3,5)',
		]);
	});
});
