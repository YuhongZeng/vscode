/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IconPathDto } from '../../common/extHost.protocol.js';
import { IconPath, WorkspaceEdit } from '../../common/extHostTypeConverters.js';
import { FileEditType, ThemeColor, ThemeIcon } from '../../common/extHostTypes.js';

suite('extHostTypeConverters', function () {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('IconPath', function () {
		suite('from', function () {
			test('undefined', function () {
				assert.strictEqual(IconPath.from(undefined), undefined);
			});

			test('ThemeIcon', function () {
				const themeIcon = new ThemeIcon('account', new ThemeColor('testing.iconForeground'));
				assert.strictEqual(IconPath.from(themeIcon), themeIcon);
			});

			test('URI', function () {
				const uri = URI.parse('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
				assert.strictEqual(IconPath.from(uri), uri);
			});

			test('string', function () {
				const str = '/path/to/icon.png';
				// eslint-disable-next-line local/code-no-any-casts
				const r1 = IconPath.from(str as any) as any as URI;
				assert.ok(URI.isUri(r1));
				assert.strictEqual(r1.scheme, 'file');
				assert.strictEqual(r1.path, str);
			});

			test('dark only', function () {
				const input = { dark: URI.file('/path/to/dark.png') };
				// eslint-disable-next-line local/code-no-any-casts
				const result = IconPath.from(input as any) as unknown as { dark: URI; light: URI };
				assert.strictEqual(typeof result, 'object');
				assert.ok('light' in result && 'dark' in result);
				assert.ok(URI.isUri(result.light));
				assert.ok(URI.isUri(result.dark));
				assert.strictEqual(result.dark.toString(), input.dark.toString());
				assert.strictEqual(result.light.toString(), input.dark.toString());
			});

			test('dark/light', function () {
				const input = { light: URI.file('/path/to/light.png'), dark: URI.file('/path/to/dark.png') };
				const result = IconPath.from(input);
				assert.strictEqual(typeof result, 'object');
				assert.ok('light' in result && 'dark' in result);
				assert.ok(URI.isUri(result.light));
				assert.ok(URI.isUri(result.dark));
				assert.strictEqual(result.dark.toString(), input.dark.toString());
				assert.strictEqual(result.light.toString(), input.light.toString());
			});

			test('dark/light strings', function () {
				const input = { light: '/path/to/light.png', dark: '/path/to/dark.png' };
				// eslint-disable-next-line local/code-no-any-casts
				const result = IconPath.from(input as any) as unknown as IconPathDto;
				assert.strictEqual(typeof result, 'object');
				assert.ok('light' in result && 'dark' in result);
				assert.ok(URI.isUri(result.light));
				assert.ok(URI.isUri(result.dark));
				assert.strictEqual(result.dark.path, input.dark);
				assert.strictEqual(result.light.path, input.light);
			});

			test('invalid object', function () {
				const invalidObject = { foo: 'bar' };
				// eslint-disable-next-line local/code-no-any-casts
				const result = IconPath.from(invalidObject as any);
				assert.strictEqual(result, undefined);
			});

			test('light only', function () {
				const input = { light: URI.file('/path/to/light.png') };
				// eslint-disable-next-line local/code-no-any-casts
				const result = IconPath.from(input as any);
				assert.strictEqual(result, undefined);
			});
		});

		suite('to', function () {
			test('undefined', function () {
				assert.strictEqual(IconPath.to(undefined), undefined);
			});

			test('ThemeIcon', function () {
				const themeIcon = new ThemeIcon('account');
				assert.strictEqual(IconPath.to(themeIcon), themeIcon);
			});

			test('URI', function () {
				const uri: UriComponents = { scheme: 'data', path: 'image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' };
				const result = IconPath.to(uri);
				assert.ok(URI.isUri(result));
				assert.strictEqual(result.toString(), URI.revive(uri).toString());
			});

			test('dark/light', function () {
				const input: { light: UriComponents; dark: UriComponents } = {
					light: { scheme: 'file', path: '/path/to/light.png' },
					dark: { scheme: 'file', path: '/path/to/dark.png' }
				};
				const result = IconPath.to(input);
				assert.strictEqual(typeof result, 'object');
				assert.ok('light' in result && 'dark' in result);
				assert.ok(URI.isUri(result.light));
				assert.ok(URI.isUri(result.dark));
				assert.strictEqual(result.dark.toString(), URI.revive(input.dark).toString());
				assert.strictEqual(result.light.toString(), URI.revive(input.light).toString());
			});
		});
	});

	suite('WorkspaceEdit', function () {
		test('to handles text and file edits', function () {
			const value = WorkspaceEdit.to({
				edits: [
					{
						resource: URI.parse('file:///workspace/test.ts'),
						textEdit: {
							range: {
								startLineNumber: 1,
								startColumn: 1,
								endLineNumber: 1,
								endColumn: 1
							},
							text: 'hello'
						},
						versionId: 1
					},
					{
						newResource: URI.parse('file:///workspace/created.ts'),
						options: { overwrite: true }
					},
					{
						oldResource: URI.parse('file:///workspace/deleted.ts'),
						options: { recursive: true }
					},
					{
						oldResource: URI.parse('file:///workspace/from.ts'),
						newResource: URI.parse('file:///workspace/to.ts'),
						options: { overwrite: true }
					}
				]
			});

			const entries = value._allEntries();
			assert.strictEqual(entries.length, 4);

			assert.strictEqual(entries[0]._type, FileEditType.File);
			assert.strictEqual(entries[1]._type, FileEditType.File);
			assert.strictEqual(entries[2]._type, FileEditType.File);
			assert.strictEqual(entries[3]._type, FileEditType.Text);

			if (entries[0]._type === FileEditType.File) {
				assert.strictEqual(entries[0].to?.toString(), 'file:///workspace/created.ts');
				assert.strictEqual(entries[0].options?.overwrite, true);
			}
			if (entries[1]._type === FileEditType.File) {
				assert.strictEqual(entries[1].from?.toString(), 'file:///workspace/deleted.ts');
				assert.strictEqual(entries[1].options?.recursive, true);
			}
			if (entries[2]._type === FileEditType.File) {
				assert.strictEqual(entries[2].from?.toString(), 'file:///workspace/from.ts');
				assert.strictEqual(entries[2].to?.toString(), 'file:///workspace/to.ts');
			}
			if (entries[3]._type === FileEditType.Text) {
				assert.strictEqual(entries[3].uri.toString(), 'file:///workspace/test.ts');
				assert.strictEqual(entries[3].edit.newText, 'hello');
			}
		});
	});
});
