/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../../base/common/observable.js';
import { mock } from '../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../../platform/keybinding/common/keybinding.js';
import { ChatEditorOverlayWidget } from '../../../browser/chatEditing/chatEditingEditorOverlay.js';
import { IChatEditingSession, IModifiedFileEntry } from '../../../common/editing/chatEditingService.js';

suite('ChatEditorOverlayWidget', function () {
	const store = new DisposableStore();
	let widget: ChatEditorOverlayWidget;

	setup(function () {
		const instantiationService = new class extends mock<IInstantiationService>() {
			override createInstance(ctor: any, ...args: any[]): any {
				return new ctor(...args);
			}
		};
		const keybindingService = new class extends mock<IKeybindingService>() { };

		widget = new ChatEditorOverlayWidget(
			{ focus: () => { } },
			keybindingService,
			instantiationService
		);
		store.add(widget);
	});

	teardown(async () => {
		store.clear();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	test('show - navigation bearings use local counts', () => {
		const session = new class extends mock<IChatEditingSession>() { } as IChatEditingSession;

		// Mock entries
		const createEntry = (changesCount: number) => ({
			changesCount: observableValue('changesCount', changesCount),
			waitsForLastEdits: observableValue('waits', false)
		} as unknown as IModifiedFileEntry);

		const entry1 = createEntry(2);
		const entry2 = createEntry(3);
		const entry3 = createEntry(5); // Total 10 changes

		const entries = [entry1, entry2, entry3];
		(session as any).entries = observableValue('entries', entries);

		// Scenario 1: File 1, Change 1 (Index 0)
		const entryIndex = observableValue('entryIndex', 0);
		const changeIndex = observableValue('changeIndex', 0); // 1st change in file 1

		widget.show(session, entry1, { entryIndex, changeIndex });

		let bearings = (widget as any)._navigationBearings.get();
		assert.strictEqual(bearings.changeCount, 2, 'File 1 change count should be 2');
		assert.strictEqual(bearings.activeIdx, 0, 'File 1 active index should be 0');
		assert.strictEqual(bearings.entriesCount, 3, 'Total files should be 3');
		assert.strictEqual(bearings.activeEntryIdx, 0, 'Current file index should be 0');

		// Scenario 2: File 2, Change 2 (Index 1)
		entryIndex.set(1, undefined);
		changeIndex.set(1, undefined); // 2nd change in file 2

		// In the real app, show is called when active editor changes.
		// So we call show again with new entry.
		widget.show(session, entry2, { entryIndex, changeIndex });

		bearings = (widget as any)._navigationBearings.get();
		assert.strictEqual(bearings.changeCount, 3, 'File 2 change count should be 3');
		assert.strictEqual(bearings.activeIdx, 1, 'File 2 active index should be 1');
		assert.strictEqual(bearings.entriesCount, 3);
		assert.strictEqual(bearings.activeEntryIdx, 1);

		// Scenario 3: File 3, Change 5 (Index 4)
		entryIndex.set(2, undefined);
		changeIndex.set(4, undefined);
		widget.show(session, entry3, { entryIndex, changeIndex });

		bearings = (widget as any)._navigationBearings.get();
		assert.strictEqual(bearings.changeCount, 5, 'File 3 change count should be 5');
		assert.strictEqual(bearings.activeIdx, 4, 'File 3 active index should be 4');
		assert.strictEqual(bearings.entriesCount, 3);
		assert.strictEqual(bearings.activeEntryIdx, 2);
	});
});
