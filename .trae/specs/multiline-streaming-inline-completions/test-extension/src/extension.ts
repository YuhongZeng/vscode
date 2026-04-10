import * as vscode from 'vscode';

let streamingState: { text: string; isActive: boolean; position: vscode.Position | null; mode: 'streaming' | 'static' } = { text: '', isActive: false, position: null, mode: 'streaming' };

export function activate(context: vscode.ExtensionContext) {
	console.log('Streaming inline completion test extension is now active!');

	let timer: NodeJS.Timeout | null = null;

	const provider: vscode.InlineCompletionItemProvider = {
		provideInlineCompletionItems(document, position, context, token) {
			if (!streamingState.isActive || !streamingState.position) {
				return [];
			}

			// If the position has moved away significantly, we might want to cancel
			// But for this test, we just return the current streaming text at the original position

			const range = new vscode.Range(streamingState.position, streamingState.position);

			if (streamingState.mode === 'static') {
				const staticText = "function staticCompletion() {\n    console.log('This is a static, non-streaming completion');\n    return true;\n}";
				return [
					new vscode.InlineCompletionItem(staticText, range)
				];
			} else {
				return [
					new vscode.InlineCompletionItem(streamingState.text, range)
				];
			}
		}
	};

	context.subscriptions.push(
		vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('streaming-inline-completion-test.startStatic', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				return;
			}

			if (timer) {
				clearInterval(timer);
				timer = null;
			}

			streamingState.isActive = true;
			streamingState.mode = 'static';
			streamingState.position = editor.selection.active;
			streamingState.text = '';

			await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('streaming-inline-completion-test.startStreaming', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				return;
			}

			streamingState.isActive = true;
			streamingState.mode = 'streaming';
			streamingState.position = editor.selection.active;
			streamingState.text = '';

			const textChunks = [
				"func",
				"tion ",
				"comp",
				"uteSo",
				"methi",
				"ng() ",
				"{\n",
				"    c",
				"onst ",
				"a = ",
				"10;\n",
				"    c",
				"onst ",
				"b = ",
				"20;\n",
				"    /",
				"/ Let",
				"'s do",
				" some",
				" comp",
				"lex c",
				"alcul",
				"ation\n",
				"    f",
				"or (l",
				"et i ",
				"= 0; ",
				"i < 1",
				"00; i",
				"++) {\n",
				"     ",
				"   co",
				"nsole",
				".log(",
				"a + b",
				" + i)",
				";\n",
				"    }\n",
				"    r",
				"eturn",
				" a + ",
				"b;\n",
				"}\n"
			];

			let currentIndex = 0;

			if (timer) {
				clearInterval(timer);
			}

			timer = setInterval(async () => {
				if (currentIndex >= textChunks.length) {
					clearInterval(timer!);
					timer = null;
					streamingState.isActive = false;
					return;
				}

				streamingState.text += textChunks[currentIndex];
				currentIndex++;

				// Force pull the new completion
				await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger', { force: true });
			}, 100);
		})
	);
}

export function deactivate() { }
