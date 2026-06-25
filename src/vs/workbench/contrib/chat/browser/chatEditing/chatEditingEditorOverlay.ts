/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatEditingEditorOverlay.css';
import { combinedDisposable, Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ResourceSet } from '../../../../../base/common/map.js';
import { autorun, derived, derivedOpts, IObservable, observableFromEvent, observableSignalFromEvent, observableValue, transaction } from '../../../../../base/common/observable.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar } from '../../../../../platform/actions/browser/toolbar.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IChatEditingService, IChatEditingSession, IModifiedFileEntry, ModifiedFileEntryState } from '../../common/editing/chatEditingService.js';
import { MenuId } from '../../../../../platform/actions/common/actions.js';
import { ActionViewItem, IBaseActionViewItemOptions } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IAction, IActionRunner } from '../../../../../base/common/actions.js';
import { $, addDisposableGenericMouseMoveListener, append, clearNode } from '../../../../../base/browser/dom.js';
import { assertType } from '../../../../../base/common/types.js';
import { localize } from '../../../../../nls.js';
import { AcceptAction, AcceptHunkAction, navigationBearingFakeActionId, RejectAction, fileNavigationBearingFakeActionId, ChatEditingEditorFileContentMenuId } from './chatEditingEditorActions.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { EditorGroupView } from '../../../../browser/parts/editor/editorGroupView.js';
import { Event } from '../../../../../base/common/event.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { EditorResourceAccessor, SideBySideEditor } from '../../../../common/editor.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { isCodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { createChatEditNavigationHunks, getChatEditOverlayActiveIndex, IChatEditNavigationHunk } from './chatEditingNavigationUtils.js';

export class ChatEditingAcceptRejectActionViewItem extends ActionViewItem {

	private readonly _reveal = this._store.add(new MutableDisposable());

	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions,
		private readonly _activeData: IObservable<{ session: IChatEditingSession; entry: IModifiedFileEntry }[] | undefined> | undefined,
		private readonly _editor: { focus(): void } | undefined,
		private readonly _keybindingService: IKeybindingService,
		private readonly _primaryActionIds: readonly string[] = [AcceptAction.ID, AcceptHunkAction.ID],
	) {
		super(undefined, action, { ...options, icon: false, label: true, keybindingNotRenderedWithLabel: true });
	}

	override render(container: HTMLElement): void {
		super.render(container);

		if (this._primaryActionIds.includes(this._action.id)) {
			this.element?.classList.add('primary');
		}

		if (this._action.id === AcceptAction.ID && this._activeData) {

			const listener = this._store.add(new MutableDisposable());

			this._store.add(autorun(r => {

				assertType(this.label);
				assertType(this.element);

				const data = this._activeData!.read(r);

				// Find the controller with the maximum remaining time
				let maxCtrl = undefined;
				for (const d of (data || [])) {
					const ctrl = d.entry.autoAcceptController.read(r);
					if (ctrl && (!maxCtrl || ctrl.remaining > maxCtrl.remaining)) {
						maxCtrl = ctrl;
					}
				}
				const ctrl = maxCtrl;
				if (ctrl) {

					const ratio = -100 * (ctrl.remaining / ctrl.total);

					this.element.style.setProperty('--vscode-action-item-auto-timeout', `${ratio}%`);

					this.element.classList.toggle('auto', true);
					listener.value = addDisposableGenericMouseMoveListener(this.element, () => ctrl.cancel());
				} else {
					this.element.classList.toggle('auto', false);
					listener.clear();
				}
			}));
		}
	}


	override updateLabel(): void {
		if (this.options.label && this.label) {
			clearNode(this.label);

			const keybinding = this._keybindingService.lookupKeybinding(this.action.id);
			if (keybinding) {
				const kbLabel = keybinding.getLabel();
				if (kbLabel) {
					const kbSpan = append(this.label, $('span.chat-editing-action-keybinding'));
					kbSpan.textContent = kbLabel;
				}
				this.label.classList.add('has-keybinding');
			} else {
				this.label.classList.remove('has-keybinding');
			}

			const labelSpan = append(this.label, $('span'));
			labelSpan.textContent = this.action.label;
		}
	}

	override set actionRunner(actionRunner: IActionRunner) {
		super.actionRunner = actionRunner;
		if (this._editor) {
			this._reveal.value = actionRunner.onWillRun(_e => {
				this._editor!.focus();
			});
		}
	}

	override get actionRunner(): IActionRunner {
		return super.actionRunner;
	}

	protected override getTooltip(): string | undefined {
		const value = super.getTooltip();
		if (!value || this.options.keybinding) {
			return value;
		}
		return this._keybindingService.appendKeybinding(value, this._action.id);
	}
}

export class ChatEditorOverlayWidget extends Disposable {

	private readonly _domNode: HTMLElement;
	private readonly _toolbarNode: HTMLElement;
	private readonly _fileToolbarNode: HTMLElement;

	private readonly _showStore = this._store.add(new DisposableStore());

	private readonly _activeData = observableValue<{ session: IChatEditingSession; entry: IModifiedFileEntry }[] | undefined>(this, undefined);

	private readonly _isBusy: IObservable<boolean>;

	private readonly _navigationBearings = observableValue<{ changeCount: number; activeIdx: number; entriesCount: number; activeEntryIdx: number }>(this, { changeCount: -1, activeIdx: -1, entriesCount: -1, activeEntryIdx: -1 });

	constructor(
		private readonly _editor: { focus(): void },
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
		@IInstantiationService private readonly _instaService: IInstantiationService,
	) {
		super();
		this._domNode = document.createElement('div');
		this._domNode.classList.add('chat-editor-overlay-widget');

		this._isBusy = derived(r => {
			const data = this._activeData.read(r);
			return data?.some(d => d.entry.waitsForLastEdits.read(r)) ?? false;
		});


		const progressNode = document.createElement('div');
		progressNode.classList.add('chat-editor-overlay-progress');
		append(progressNode, renderIcon(ThemeIcon.modify(Codicon.loading, 'spin')));
		const textProgress = append(progressNode, $('span.progress-message'));
		this._domNode.appendChild(progressNode);

		this._store.add(autorun(r => {
			const busy = this._isBusy.read(r);

			this._domNode.classList.toggle('busy', busy);
			textProgress.innerText = '';
		}));

		this._toolbarNode = document.createElement('div');
		this._toolbarNode.classList.add('chat-editor-overlay-toolbar');
		this._fileToolbarNode = document.createElement('div');
		this._fileToolbarNode.classList.add('chat-editor-overlay-toolbar', 'file-toolbar');

		this._domNode.style.display = 'flex';
		this._domNode.style.gap = '10px';
		this._domNode.style.alignItems = 'center';
	}

	override dispose() {
		this.hide();
		super.dispose();
	}

	getDomNode(): HTMLElement {
		return this._domNode;
	}

	show(data: { session: IChatEditingSession; entry: IModifiedFileEntry }[], changeIndex: IObservable<number>, fileNavigation: IObservable<{ entriesCount: number; activeEntryIdx: number }>) {

		this._showStore.clear();

		transaction(tx => {
			this._activeData.set(data, tx);
		});

		this._showStore.add(autorun(r => {

			const activeIdx = changeIndex.read(r);
			const { entriesCount, activeEntryIdx } = fileNavigation.read(r);

			// Aggregate change count across all entries
			let changeCount = 0;
			const seenUris = new ResourceSet();
			for (const { entry } of data) {
				if (!seenUris.has(entry.modifiedURI)) {
					seenUris.add(entry.modifiedURI);
					changeCount += entry.changesCount.read(r);
				}
			}

			this._navigationBearings.set({ changeCount, activeIdx, entriesCount, activeEntryIdx }, undefined);
		}));

		this._domNode.appendChild(this._toolbarNode);
		this._domNode.appendChild(this._fileToolbarNode);

		this._showStore.add(toDisposable(() => {
			this._toolbarNode.remove();
			this._fileToolbarNode.remove();
		}));

		const actionViewItemProvider = (action: IAction, options: IBaseActionViewItemOptions) => {
			const that = this;

			if (action.id === navigationBearingFakeActionId) {
				return new class extends ActionViewItem {

					constructor() {
						super(undefined, action, { ...options, icon: false, label: true, keybindingNotRenderedWithLabel: true });
					}

					override render(container: HTMLElement) {
						super.render(container);

						container.classList.add('label-item');

						this._store.add(autorun(r => {
							assertType(this.label);

							const { changeCount, activeIdx } = that._navigationBearings.read(r);

							if (changeCount > 0) {
								const n = activeIdx === -1 ? '1' : `${activeIdx + 1}`;
								this.label.innerText = `${n}/${changeCount}`;
							} else {
								// allow-any-unicode-next-line
								this.label.innerText = localize('0Of0', "—");
							}

							this.updateTooltip();
						}));
					}

					protected override getTooltip(): string | undefined {
						const { changeCount, entriesCount } = that._navigationBearings.get();
						if (changeCount === -1 || entriesCount === -1) {
							return undefined;
						}
						let result: string | undefined;
						if (changeCount === 1 && entriesCount === 1) {
							result = localize('tooltip_11', "1 change in 1 file");
						} else if (changeCount === 1) {
							result = localize('tooltip_1n', "1 change in {0} files", entriesCount);
						} else if (entriesCount === 1) {
							result = localize('tooltip_n1', "{0} changes in 1 file", changeCount);
						} else {
							result = localize('tooltip_nm', "{0} changes in {1} files", changeCount, entriesCount);
						}
						if (!that._isBusy.get()) {
							return result;
						}
						return localize('tooltip_busy', "{0} - Working...", result);
					}
				};
			}

			if (action.id === fileNavigationBearingFakeActionId) {
				return new class extends ActionViewItem {
					constructor() {
						super(undefined, action, { ...options, icon: false, label: true, keybindingNotRenderedWithLabel: true });
					}

					override render(container: HTMLElement) {
						super.render(container);
						container.classList.add('label-item');

						this._store.add(autorun(r => {
							assertType(this.label);
							const { activeEntryIdx, entriesCount } = that._navigationBearings.read(r);

							if (entriesCount > 0) {
								const fileN = activeEntryIdx === -1 ? '?' : `${activeEntryIdx + 1}`;
								this.label.innerText = `${fileN}/${entriesCount} files`;
							} else {
								// allow-any-unicode-next-line
								this.label.innerText = localize('0Of0', "—");
							}
						}));
					}
				};
			}

			if (action.id === AcceptAction.ID || action.id === RejectAction.ID) {
				return new ChatEditingAcceptRejectActionViewItem(action, options, that._activeData, that._editor, that._keybindingService);
			}

			return undefined;
		};

		this._showStore.add(this._instaService.createInstance(MenuWorkbenchToolBar, this._toolbarNode, MenuId.ChatEditingEditorContent, {
			telemetrySource: 'chatEditor.overlayToolbar',
			hiddenItemStrategy: HiddenItemStrategy.Ignore,
			toolbarOptions: {
				primaryGroup: () => true,
				useSeparatorsInPrimaryActions: true
			},
			menuOptions: { renderShortTitle: true },
			actionViewItemProvider
		}));

		this._showStore.add(this._instaService.createInstance(MenuWorkbenchToolBar, this._fileToolbarNode, ChatEditingEditorFileContentMenuId, {
			telemetrySource: 'chatEditor.overlayFileToolbar',
			hiddenItemStrategy: HiddenItemStrategy.Ignore,
			toolbarOptions: {
				primaryGroup: () => true,
				useSeparatorsInPrimaryActions: true
			},
			menuOptions: { renderShortTitle: true },
			actionViewItemProvider
		}));
	}

	hide() {
		transaction(tx => {
			this._activeData.set(undefined, tx);
			this._navigationBearings.set({ changeCount: -1, activeIdx: -1, entriesCount: -1, activeEntryIdx: -1 }, tx);
		});
		this._showStore.clear();
		this._toolbarNode.remove();
	}
}

class ChatEditingOverlayController {

	private readonly _store = new DisposableStore();

	private readonly _domNode = document.createElement('div');

	constructor(
		container: HTMLElement,
		group: IEditorGroup,
		@IInstantiationService instaService: IInstantiationService,
		@IChatEditingService chatEditingService: IChatEditingService,
	) {

		this._domNode.classList.add('chat-editing-editor-overlay');
		this._domNode.style.position = 'absolute';
		this._domNode.style.bottom = `24px`;
		this._domNode.style.right = '0';
		this._domNode.style.left = '0';
		this._domNode.style.justifyContent = 'center';
		this._domNode.style.display = 'flex';
		this._domNode.style.zIndex = `100`;

		const widget = instaService.createInstance(ChatEditorOverlayWidget, group);
		this._domNode.appendChild(widget.getDomNode());
		this._store.add(toDisposable(() => this._domNode.remove()));
		this._store.add(widget);

		const show = () => {
			if (!container.contains(this._domNode)) {
				container.appendChild(this._domNode);
			}
		};

		const hide = () => {
			if (container.contains(this._domNode)) {
				widget.hide();
				this._domNode.remove();
			}
		};

		const activeEditorSignal = observableSignalFromEvent(this, Event.any(group.onDidActiveEditorChange, group.onDidModelChange));

		const cursorPosition = observableValue<Position | null>(this, null);
		const cursorListener = this._store.add(new MutableDisposable());
		const updateCursorPosition = () => {
			const control = group.activeEditorPane?.getControl();
			if (isCodeEditor(control)) {
				cursorPosition.set(control.getPosition(), undefined);
				cursorListener.value = control.onDidChangeCursorPosition(() => {
					cursorPosition.set(control.getPosition(), undefined);
				});
			} else {
				cursorPosition.set(null, undefined);
				cursorListener.value = undefined;
			}
		};

		this._store.add(Event.any(group.onDidActiveEditorChange, group.onDidModelChange)(updateCursorPosition));
		updateCursorPosition();

		const activeUriObs = derivedOpts({ equalsFn: isEqual }, r => {

			activeEditorSignal.read(r); // signal

			const activeEditor = group.activeEditor;
			const paneInput = group.activeEditorPane?.input;

			if (activeEditor && (!paneInput || !activeEditor.matches(paneInput))) {
				return undefined;
			}

			const uri = EditorResourceAccessor.getOriginalUri(activeEditor, { supportSideBySide: SideBySideEditor.PRIMARY });

			return uri;
		});

		const fileNavigation = derived(r => {
			const sessions = chatEditingService.editingSessionsObs.read(r).filter(s => s.isGlobalEditingSession);

			const modifiedUris = new Set<string>();

			for (const session of sessions) {
				const entries = session.entries.read(r);
				for (const entry of entries) {
					if (entry.state.read(r) === ModifiedFileEntryState.Modified && chatEditingService.isEntryPreviewVisible(entry, r)) {
						const targetUri = entry.isDeletion ? entry.originalURI : entry.modifiedURI;
						modifiedUris.add(targetUri.toString());
					}
				}
			}

			const activeUri = activeUriObs.read(r);
			let activeEntryIdx = -1;
			if (activeUri && modifiedUris.has(activeUri.toString())) {
				const sortedUris = Array.from(modifiedUris).sort();
				activeEntryIdx = sortedUris.indexOf(activeUri.toString());
			}

			return { entriesCount: modifiedUris.size, activeEntryIdx };
		});

		const sessionAndEntry = derived(r => {

			activeEditorSignal.read(r); // signal to ensure activeEditor and activeEditorPane don't go out of sync

			const uri = activeUriObs.read(r);
			if (!uri) {
				return undefined;
			}

			const data: { session: IChatEditingSession; entry: IModifiedFileEntry }[] = [];

			// Directly query global editing sessions (inline chat has its own overlay)
			if (!chatEditingService.editingEditorVisibility.read(r)) {
				return undefined;
			}

			for (const session of chatEditingService.editingSessionsObs.read(r)) {
				if (!session.isGlobalEditingSession) {
					continue;
				}
				const entry = session.entries.read(r).find(e => {
					if (e.modifiedURI.toString() === uri.toString()) { return true; }
					if (e.isDeletion && e.originalURI?.toString() === uri.toString()) { return true; }
					return false;
				});
				if (entry) {
					data.push({ session, entry });
				}
			}

			return data.length > 0 ? data : undefined;
		});

		this._store.add(autorun(r => {

			const data = sessionAndEntry.read(r);

			if (!data) {
				hide();
				return;
			}

			const isAnyModified = data.some(d => d.entry.state.read(r) === ModifiedFileEntryState.Modified && chatEditingService.isEntryPreviewVisible(d.entry, r));

			if (isAnyModified) {
				// any session with changes
				const editorPane = group.activeEditorPane;
				assertType(editorPane);

				// Initialize editor integrations so that change block UIs are rendered
				const firstModified = data.find(d => d.entry.state.read(r) === ModifiedFileEntryState.Modified && chatEditingService.isEntryPreviewVisible(d.entry, r));
				if (firstModified) {
					firstModified.entry.getEditorIntegration(editorPane);
				}

				const changeIndex = derived(r => {
					const position = cursorPosition.read(r);
					if (!position) {
						return -1;
					}

					const control = group.activeEditorPane?.getControl();
					const model = isCodeEditor(control) ? control.getModel() ?? undefined : undefined;
					const resourceKey = model?.uri.toString();
					const allChanges: IChatEditNavigationHunk[] = [];
					const seenUris = new ResourceSet();
					for (const { entry } of data) {
						if (entry.state.read(r) !== ModifiedFileEntryState.Modified || !chatEditingService.isEntryPreviewVisible(entry, r)) {
							continue;
						}
						if (seenUris.has(entry.modifiedURI)) {
							continue;
						}
						seenUris.add(entry.modifiedURI);

						const diff = entry.diffInfo?.read(r);
						if (diff) {
							allChanges.push(...createChatEditNavigationHunks(diff.changes.map(change => change.modified), model ?? undefined));
						}
					}

					if (allChanges.length === 0) {
						return -1;
					}

					return getChatEditOverlayActiveIndex(allChanges, position, isCodeEditor(control) ? control : undefined, resourceKey);
				});

				widget.show(data, changeIndex, fileNavigation);
				show();

			} else {
				// nothing
				hide();
			}
		}));
	}

	dispose(): void {
		this._store.dispose();
	}
}

export class ChatEditingEditorOverlay implements IWorkbenchContribution {

	static readonly ID = 'chat.edits.editorOverlay';

	private readonly _store = new DisposableStore();

	constructor(
		@IEditorGroupsService editorGroupsService: IEditorGroupsService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {

		const editorGroups = observableFromEvent(
			this,
			Event.any(editorGroupsService.onDidAddGroup, editorGroupsService.onDidRemoveGroup),
			() => editorGroupsService.groups
		);

		const overlayWidgets = this._store.add(new DisposableMap<IEditorGroup>());

		this._store.add(autorun(r => {

			const toDelete = new Set(overlayWidgets.keys());
			const groups = editorGroups.read(r);


			for (const group of groups) {

				if (!(group instanceof EditorGroupView)) {
					// TODO@jrieken better with https://github.com/microsoft/vscode/tree/ben/layout-group-container
					continue;
				}

				toDelete.delete(group); // we keep the widget for this group!

				if (!overlayWidgets.has(group)) {

					const scopedInstaService = instantiationService.createChild(
						new ServiceCollection([IContextKeyService, group.scopedContextKeyService])
					);

					const container = group.element;

					const ctrl = scopedInstaService.createInstance(ChatEditingOverlayController, container, group);
					overlayWidgets.set(group, combinedDisposable(ctrl, scopedInstaService));
				}
			}

			for (const group of toDelete) {
				overlayWidgets.deleteAndDispose(group);
			}
		}));
	}

	dispose(): void {
		this._store.dispose();
	}
}
