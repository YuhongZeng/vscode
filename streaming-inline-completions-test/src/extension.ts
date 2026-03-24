import * as vscode from 'vscode';
import { registerTestScripts } from './test-scripts';

export function activate(context: vscode.ExtensionContext) {
	console.log('Streaming Inline Completion Test Plugin Activated');

	registerTestScripts(context);

	const lines = [
		"function calculateSum(a: number, b: number) {",
		"    console.log('Calculating sum...');",
		"    const result = a + b;",
		"    return result;",
		"}"
	];
	const fullText = lines.join('\n');

	// Register commands to trigger completions
	context.subscriptions.push(
		vscode.commands.registerCommand('streamingPlugin.triggerStream', () => {
			vscode.commands.executeCommand('editor.action.inlineSuggest.trigger', { streaming: true, changeHintData: { streaming: true } });
		}),
		vscode.commands.registerCommand('streamingPlugin.triggerNormal', () => {
			vscode.commands.executeCommand('editor.action.inlineSuggest.trigger', { streaming: false, changeHintData: { streaming: false } });
		})
	);

	const onDidChangeEmitter = new vscode.EventEmitter<any>();
	let isStreamingMode = false;
	let currentText = "";
	let streamIndex = 0;

	// Register Inline Completion Provider
	const provider: any = {
		onDidChange: onDidChangeEmitter.event,
		// @ts-ignore
		provideInlineCompletionItems(document, position, context, token) {
			const streaming = (context as any).changeHint?.data?.streaming;

			if (streaming) {
				console.log(`Providing STREAMING inline completions... current length: ${currentText.length}`);

				if (!isStreamingMode) {
					isStreamingMode = true;
					currentText = fullText[0];
					streamIndex = 1;
				}

				if (streamIndex < fullText.length) {
					setTimeout(() => {
						if (!token.isCancellationRequested) {
							const chunkSize = Math.floor(Math.random() * 5) + 1;
							currentText += fullText.slice(streamIndex, streamIndex + chunkSize);
							streamIndex += chunkSize;
							onDidChangeEmitter.fire({ data: { streaming: true } });
						} else {
							console.log("Token cancelled, stopping stream.");
							isStreamingMode = false;
						}
					}, 15);
				} else {
					console.log("Stream finished.");
					isStreamingMode = false;
				}

				return {
					items: [{
						insertText: currentText,
						range: new vscode.Range(position, position)
					}],
					isStreaming: streamIndex < fullText.length
				} as any;
			} else {
				console.log("Providing NORMAL inline completions...");
				// Reset streaming state just in case
				isStreamingMode = false;
				return [{
					insertText: "const normalCompletion = 'This is instantly returned';",
					range: new vscode.Range(position, position)
				}];
			}
		}
	};

	context.subscriptions.push(
		vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider)
	);
}

export function deactivate() { }
