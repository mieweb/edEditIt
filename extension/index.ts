import * as vscode from 'vscode';
import { MarkdownEditorProvider } from './markdownEditorProvider.js';

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(MarkdownEditorProvider.register(context));
}

export function deactivate() {}
