import * as vscode from 'vscode';

/**
 * edEditIt extension entry point. Phase 1 registers a custom editor for
 * Markdown that hosts the Kerebron ProseMirror editor in a webview.
 */
export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(MarkdownEditorProvider.register(context));
}

export function deactivate(): void {}

class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  private static readonly viewType = 'ededitit.markdown';

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      MarkdownEditorProvider.viewType,
      new MarkdownEditorProvider(),
    );
  }

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
  ): void {
    webviewPanel.webview.options = { enableScripts: true };
    webviewPanel.webview.html =
      `<!doctype html><body><pre>${document.getText()}</pre>` +
      `<p>Kerebron editor to be embedded in Phase 1.</p></body>`;
  }
}
