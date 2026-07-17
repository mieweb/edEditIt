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
      new MarkdownEditorProvider(context),
    );
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
  ): void {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
    };
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview, mediaRoot);

    // The last text the webview and the document agree on. Used to break the
    // edit loop: edits we apply ourselves echo back through
    // onDidChangeTextDocument and must not be pushed to the webview again.
    let lastSyncedText = document.getText();

    const postDocument = (type: 'init' | 'update'): void => {
      void webviewPanel.webview.postMessage({ type, text: document.getText() });
    };

    const changeSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) {
        return;
      }
      const text = e.document.getText();
      if (text === lastSyncedText) {
        return;
      }
      lastSyncedText = text;
      postDocument('update');
    });

    const messageSubscription = webviewPanel.webview.onDidReceiveMessage(
      (message) => {
        switch (message?.type) {
          case 'ready':
            lastSyncedText = document.getText();
            postDocument('init');
            break;
          case 'edit':
            void this.applyEdit(
              document,
              String(message.text ?? ''),
              (text) => {
                lastSyncedText = text;
              },
            );
            break;
        }
      },
    );

    webviewPanel.onDidDispose(() => {
      changeSubscription.dispose();
      messageSubscription.dispose();
    });
  }

  private async applyEdit(
    document: vscode.TextDocument,
    text: string,
    onApplied: (text: string) => void,
  ): Promise<void> {
    if (text === document.getText()) {
      return;
    }
    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length),
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, fullRange, text);
    onApplied(text);
    await vscode.workspace.applyEdit(edit);
  }

  private getHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const baseUri = webview.asWebviewUri(mediaRoot).toString().replace(
      /\/?$/,
      '/',
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaRoot, 'webview.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaRoot, 'webview.css'),
    );
    const nonce = getNonce();
    // Scripts are limited to our own locally bundled webview code (cspSource +
    // nonce); no remote origins are allowed. 'unsafe-eval' is required because
    // the bundled web-tree-sitter (emscripten) glue evaluates EM_ASM/EM_JS
    // helpers when the Markdown grammar wasm loads.
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data: blob:`,
      `font-src ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource} 'wasm-unsafe-eval' 'unsafe-eval' 'nonce-${nonce}'`,
      `connect-src ${webview.cspSource} blob: data:`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <base href="${baseUri}" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>edEditIt — Kerebron Markdown</title>
  </head>
  <body>
    <main id="editor" class="editor-host" aria-label="Markdown editor"></main>
    <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

function getNonce(): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
