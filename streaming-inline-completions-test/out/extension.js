"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const test_scripts_1 = require("./test-scripts");
function activate(context) {
    console.log('Streaming Inline Completion Test Plugin Activated');
    (0, test_scripts_1.registerTestScripts)(context);
    const lines = [
        "function calculateSum(a: number, b: number) {",
        "    console.log('Calculating sum...');",
        "    const result = a + b;",
        "    return result;",
        "}"
    ];
    const fullText = lines.join('\n');
    // Register commands to trigger completions
    context.subscriptions.push(vscode.commands.registerCommand('streamingPlugin.triggerStream', () => {
        vscode.commands.executeCommand('editor.action.inlineSuggest.trigger', { streaming: true, changeHintData: { streaming: true } });
    }), vscode.commands.registerCommand('streamingPlugin.triggerNormal', () => {
        vscode.commands.executeCommand('editor.action.inlineSuggest.trigger', { streaming: false, changeHintData: { streaming: false } });
    }));
    const onDidChangeEmitter = new vscode.EventEmitter();
    let isStreamingMode = false;
    let currentText = "";
    let streamIndex = 0;
    // Register Inline Completion Provider
    const provider = {
        onDidChange: onDidChangeEmitter.event,
        // @ts-ignore
        provideInlineCompletionItems(document, position, context, token) {
            const streaming = context.changeHint?.data?.streaming;
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
                        }
                        else {
                            console.log("Token cancelled, stopping stream.");
                            isStreamingMode = false;
                        }
                    }, 15);
                }
                else {
                    console.log("Stream finished.");
                    isStreamingMode = false;
                }
                return {
                    items: [{
                            insertText: currentText,
                            range: new vscode.Range(position, position)
                        }],
                    isStreaming: streamIndex < fullText.length
                };
            }
            else {
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
    context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider));
}
function deactivate() { }
//# sourceMappingURL=extension.js.map