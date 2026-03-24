import * as vscode from 'vscode';

export function registerTestScripts(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('streamingPlugin.test.smoothInput', async () => {
            const doc = await vscode.workspace.openTextDocument({ content: '\n\n' });
            const editor = await vscode.window.showTextDocument(doc);
            
            editor.selection = new vscode.Selection(1, 0, 1, 0);
            
            // Trigger streaming completion
            await vscode.commands.executeCommand('streamingPlugin.triggerStream');
            
            // Wait for streaming to start
            await new Promise(r => setTimeout(r, 50));
            
            // Simulate user typing smoothly during streaming
            // The completion should be stable and update forward
            await editor.edit(builder => builder.insert(editor.selection.active, 'f'));
            await new Promise(r => setTimeout(r, 50));
            await editor.edit(builder => builder.insert(editor.selection.active, 'u'));
            await new Promise(r => setTimeout(r, 50));
            await editor.edit(builder => builder.insert(editor.selection.active, 'n'));
            
            vscode.window.showInformationMessage('Smooth input test finished. Check if inline completion is still visible and correct.');
        }),

        vscode.commands.registerCommand('streamingPlugin.test.cursorEscape', async () => {
            const doc = await vscode.workspace.openTextDocument({ content: '\n\n' });
            const editor = await vscode.window.showTextDocument(doc);
            
            editor.selection = new vscode.Selection(1, 0, 1, 0);
            
            // Trigger streaming completion
            await vscode.commands.executeCommand('streamingPlugin.triggerStream');
            
            // Wait for streaming to start
            await new Promise(r => setTimeout(r, 50));
            
            // Simulate cursor escape (moving cursor away)
            // This should trigger CancellationToken to cancel the stream
            const newPosition = new vscode.Position(0, 0);
            editor.selection = new vscode.Selection(newPosition, newPosition);
            
            vscode.window.showInformationMessage('Cursor escape test finished. Check debug console for "Token cancelled" message.');
        }),

        vscode.commands.registerCommand('streamingPlugin.test.chaoticRollback', async () => {
            const doc = await vscode.workspace.openTextDocument({ content: '\n\n' });
            const editor = await vscode.window.showTextDocument(doc);
            
            editor.selection = new vscode.Selection(1, 0, 1, 0);
            
            // Trigger streaming completion
            await vscode.commands.executeCommand('streamingPlugin.triggerStream');
            
            // Wait for streaming to start
            await new Promise(r => setTimeout(r, 50));
            
            // Simulate chaotic input
            await editor.edit(builder => builder.insert(editor.selection.active, 'x'));
            await new Promise(r => setTimeout(r, 20));
            await editor.edit(builder => builder.insert(editor.selection.active, 'y'));
            await new Promise(r => setTimeout(r, 20));
            await editor.edit(builder => builder.insert(editor.selection.active, 'z'));
            
            // Simulate rollback (undo)
            await new Promise(r => setTimeout(r, 100));
            await vscode.commands.executeCommand('undo');
            await new Promise(r => setTimeout(r, 100));
            await vscode.commands.executeCommand('undo');
            
            vscode.window.showInformationMessage('Chaotic input rollback test finished. Check if extension handled it gracefully without crashing.');
        })
    );
}
