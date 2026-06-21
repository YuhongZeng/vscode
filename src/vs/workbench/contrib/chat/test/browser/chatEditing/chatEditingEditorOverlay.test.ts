/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { Position } from '../../../../../../editor/common/core/position.js';
import { LineRange } from '../../../../../../editor/common/core/ranges/lineRange.js';
import { createChatEditNavigationHunks, getChatEditOverlayActiveIndex, setRememberedChatEditAnchor } from '../../../browser/chatEditing/chatEditingNavigationUtils.js';

suite('ChatEditingEditorOverlay', function () {
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

	test('overlay sequence follows logical delete-only gap anchors', function () {
		const hunks = createDeleteOnlyHunks([8, 9, 10]);
		assert.deepStrictEqual([
			getChatEditOverlayActiveIndex(hunks, new Position(7, 1)),
			getChatEditOverlayActiveIndex(hunks, new Position(8, 1)),
			getChatEditOverlayActiveIndex(hunks, new Position(9, 1)),
			getChatEditOverlayActiveIndex(hunks, new Position(9, 2)),
		], [
			0,
			0,
			1,
			1,
		]);
	});

	test('overlay sequence stays stable when multiple delete-only anchors share the same cursor position', function () {
		const owner = {};
		const hunks = createDeleteOnlyHunks([1, 2, 4, 5], 3);
		setRememberedChatEditAnchor(owner, hunks[2]);
		assert.deepStrictEqual([
			getChatEditOverlayActiveIndex(hunks, new Position(3, 5), owner),
			(setRememberedChatEditAnchor(owner, hunks[3]), getChatEditOverlayActiveIndex(hunks, new Position(3, 5), owner)),
			getChatEditOverlayActiveIndex(hunks, new Position(2, 2), owner),
		], [
			2,
			3,
			1,
		]);
	});
});
