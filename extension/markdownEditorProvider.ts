import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";

import { disposeAll } from "./dispose.js";
import { MarkdownDocument } from "./MarkdownDocument.js";

export class MarkdownEditorProvider
  implements vscode.CustomEditorProvider<MarkdownDocument> {
  public static readonly viewType = "ededitit.markdownEditor";

  private readonly webviews = new WebviewCollection();
  private activePanel: vscode.WebviewPanel | undefined;
  private lastSearch?: {
    search: string;
    replace: string;
    caseSensitive: boolean;
    regexp: boolean;
    wholeWord: boolean;
  };

  public static register(
    context: vscode.ExtensionContext,
  ): void {
    const provider = new MarkdownEditorProvider(context);

    context.subscriptions.push(vscode.window.registerCustomEditorProvider(
      MarkdownEditorProvider.viewType,
      provider,
    ));

    context.subscriptions.push(vscode.commands.registerCommand(
      "markdownEditor.find", () => provider.runFind(),
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
      "markdownEditor.replace", () => provider.runReplace(),
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
      "markdownEditor.findNext", () => provider.runFindNext(),
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
      "markdownEditor.findPrev", () => provider.runFindPrev(),
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
      "markdownEditor.replaceNext", () => provider.runReplaceNext(),
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
      "markdownEditor.replaceAll", () => provider.runReplaceAll(),
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
      "markdownEditor.exportPdf", () => provider.exportToPdf(),
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
      "markdownEditor.openBuiltinEditor", (uri: vscode.Uri) => provider.openBuiltinEditor(uri),
    ));
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  private getActivePanel(): vscode.WebviewPanel | undefined {
    const active = vscode.window.activeCustomEditor;
    if (active) {
      for (const panel of this.webviews.get(active.document.uri)) {
        return panel;
      }
    }
    return undefined;
  }

  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
    vscode.CustomDocumentEditEvent<MarkdownDocument>
  >();
  public readonly onDidChangeCustomDocument =
    this._onDidChangeCustomDocument.event;

  async saveCustomDocument(
    document: MarkdownDocument,
    cancellation: vscode.CancellationToken,
  ): Promise<void> {
    if (cancellation.isCancellationRequested) {
      return;
    }
    const mime = this.mimeFromUri(document.uri);
    this.assertExportable(mime);
    const data = await document.getFileData(mime);
    if (cancellation.isCancellationRequested) {
      return;
    }
    await vscode.workspace.fs.writeFile(document.uri, data);
    this._lastSaveTime = Date.now();
    document.markClean();
  }

  private mimeFromUri(uri: vscode.Uri): string {
    const ext = uri.path.split(".").pop()?.toLowerCase();
    switch (ext) {
      case "odt":
        return "application/vnd.oasis.opendocument.text";
      case "html":
        return "text/html";
      case "docx":
        return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      default:
        return "text/markdown";
    }
  }

  private assertExportable(mime: string): void {
    if (mime === "application/vnd.oasis.opendocument.text") {
      throw new Error(
        "Export to ODT is not supported. Export to HTML or Markdown only.",
      );
    }
  }

  private async loadPasteRules(): Promise<string | undefined> {
    try {
      const configDir = process.env.XDG_CONFIG_HOME ||
        path.join(os.homedir(), ".config");
      const filePath = path.join(configDir, "paste-rules.yml");
      const uri = vscode.Uri.file(filePath);
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type === vscode.FileType.File) {
        const bytes = await vscode.workspace.fs.readFile(uri);
        return new TextDecoder("utf-8").decode(bytes);
      }
    } catch {
      // File doesn't exist or unreadable — no paste rules
    }
    return undefined;
  }

  async saveCustomDocumentAs(
    document: MarkdownDocument,
    destination: vscode.Uri,
    cancellation: vscode.CancellationToken,
  ): Promise<void> {
    if (cancellation.isCancellationRequested) {
      return;
    }

    const mime = this.mimeFromUri(destination);
    this.assertExportable(mime);
    const data = await document.getFileData(mime);

    if (cancellation.isCancellationRequested) {
      return;
    }

    await vscode.workspace.fs.writeFile(destination, data);
    document.markClean();
  }

  async revertCustomDocument(
    document: MarkdownDocument,
    cancellation: vscode.CancellationToken,
  ): Promise<void> {
    if (cancellation.isCancellationRequested) {
      return;
    }
    // Re-read file from disk
    const fileData = await vscode.workspace.fs.readFile(document.uri);
    if (cancellation.isCancellationRequested) {
      return;
    }
    // Push new content to all webviews
    for (const webviewPanel of this.webviews.get(document.uri)) {
      this.postMessage(webviewPanel, "init", {
        $to: "iframe",
        value: fileData,
        editable: true,
        baseDir: webviewPanel.webview.asWebviewUri(
          vscode.Uri.joinPath(document.uri, ".."),
        ).toString(),
      }, "revertCustomDocument");
    }

    document.markClean();
  }

  async backupCustomDocument(
    document: MarkdownDocument,
    context: vscode.CustomDocumentBackupContext,
    cancellation: vscode.CancellationToken,
  ): Promise<vscode.CustomDocumentBackup> {
    if (cancellation.isCancellationRequested) {
      return {
        id: context.destination.toString(),
        delete: async () => {/* noop */},
      };
    }

    const mime = this.mimeFromUri(document.uri);
    if (mime === "application/vnd.oasis.opendocument.text") {
      // ODT export unsupported — skip backup
      return {
        id: context.destination.toString(),
        delete: async () => {/* noop */},
      };
    }
    const data = await document.getFileData(mime);

    if (!cancellation.isCancellationRequested) {
      await vscode.workspace.fs.writeFile(context.destination, data);
    }

    return {
      id: context.destination.toString(),
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(context.destination);
        } catch {
          // ignore if already removed
        }
      },
    };
  }

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext,
    token: vscode.CancellationToken,
  ): Promise<MarkdownDocument> {
    this.debug(`openCustomDocument ` + uri);

    const document: MarkdownDocument = await MarkdownDocument.create(
      uri,
      openContext.backupId,
      {
        getFileData: async (mime?: string) => {
          const webviewsForDocument = Array.from(
            this.webviews.get(document.uri),
          );
          if (!webviewsForDocument.length) {
            throw new Error("Could not find webview to save for");
          }
          const panel = webviewsForDocument[0];

          this.debug(`getFileData ` + uri);

          const response = await this.postMessageWithResponse<
            number[]
          >(panel, "getFileData", {
            $to: "iframe",
            mime: mime ?? "text/markdown",
          });
          return new Uint8Array(response);
        },
      },
    );

    const listeners: vscode.Disposable[] = [];

    listeners.push(document.onDidChange((e) => {
      document.markDirty();
      this._onDidChangeCustomDocument.fire({
        document,
        ...e,
      });
    }));

    listeners.push(document.onDidChangeContent((e) => {
      // Update all webviews when the document changes
      for (const webviewPanel of this.webviews.get(document.uri)) {
        this.postMessage(webviewPanel, "update", {
          // edits: e.edits,
          content: e.content,
        }, "onDidChangeContent");
      }
    }));

    if (document.uri.scheme === "file") {
      const watcher = vscode.workspace.createFileSystemWatcher(
        document.uri.fsPath,
      );
      listeners.push(watcher);

      let reloadPending = false;
      listeners.push(watcher.onDidChange(async () => {
        if (reloadPending) return;
        // Ignore self-save writes
        if (Date.now() - this._lastSaveTime < 500) return;

        reloadPending = true;
        // Small debounce — some editors write in multiple passes
        await new Promise((r) => setTimeout(r, 100));

        if (document.isDirty) {
          const choice = await vscode.window.showWarningMessage(
            "File changed on disk. Reload and discard local edits?",
            "Reload",
            "Keep",
          );
          if (choice !== "Reload") {
            reloadPending = false;
            return;
          }
        }

        try {
          const fileData = await vscode.workspace.fs.readFile(document.uri);
          for (const webviewPanel of this.webviews.get(document.uri)) {
            this.postMessage(webviewPanel, "init", {
              $to: "iframe",
              value: fileData,
              editable: true,
              baseDir: webviewPanel.webview.asWebviewUri(
                vscode.Uri.joinPath(document.uri, ".."),
              ).toString(),
            }, "onDidChange");
          }
          document.markClean();
        } catch (err) {
          vscode.window.showErrorMessage("Failed to reload: " + err);
        } finally {
          reloadPending = false;
        }
      }));

      let textReloadPending = false;
      let lastTextContent = "";
      listeners.push(vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== document.uri.toString()) return;
        if (e.document.uri.scheme !== "file") return;

        const newContent = e.document.getText();
        if (newContent === lastTextContent) return;
        lastTextContent = newContent;

        if (textReloadPending) return;
        textReloadPending = true;
        setTimeout(async () => {
          textReloadPending = false;
          try {
            const panels = Array.from(this.webviews.get(document.uri));
            if (panels.length === 0) return;

            // Read latest lastTextContent (may have changed during debounce)
            const bytes = new TextEncoder().encode(lastTextContent);
            this.debug(
              `syncing text→custom, ${bytes.length} bytes`,
            );
            for (const webviewPanel of panels) {
              this.postMessage(webviewPanel, "update", {
                $to: "iframe",
                mime: "text/markdown",
                value: bytes,
              }, "onDidChangeTextDocument");
            }
          } catch (err) {
            vscode.window.showErrorMessage(
              "Failed to sync from text editor: " + err,
            );
          }
        }, 100);
      }));

      listeners.push(vscode.workspace.onDidOpenTextDocument((doc) => {
        if (doc.uri.toString() !== document.uri.toString()) return;
        if (doc.uri.scheme !== "file") return;
        vscode.window.showWarningMessage(
          "File open in text editor and custom editor. Edits may conflict.",
        );
      }));
    }

    document.onDidDispose(() => disposeAll(listeners));

    return document;
  }

  async resolveCustomEditor(
    document: MarkdownDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    this.webviews.add(document.uri, webviewPanel);

    webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.active) {
        this.activePanel = webviewPanel;
      } else if (this.activePanel === webviewPanel) {
        this.activePanel = undefined;
      }
    });
    if (webviewPanel.active) {
      this.activePanel = webviewPanel;
    }
    webviewPanel.onDidDispose(() => {
      if (this.activePanel === webviewPanel) {
        this.activePanel = undefined;
      }
    });

    const docParent = vscode.Uri.joinPath(document.uri, "..");
    const wsFolder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri;

    const localResourceRoots = [
      vscode.Uri.joinPath(this.context.extensionUri, "dist"),
      vscode.Uri.joinPath(this.context.extensionUri, "extension"),
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "node_modules",
        "@kerebron",
        "wasm",
        "assets",
      ),
      docParent,
      ...(wsFolder ? [wsFolder] : []),
    ];

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots,
    };

    webviewPanel.webview.html = await this.getWebviewContent(
      webviewPanel.webview,
      this.context,
    );
    webviewPanel.webview.onDidReceiveMessage((e) =>
      this.onMessage(document, e)
    );

    webviewPanel.webview.onDidReceiveMessage(async (e) => {
      this.debug(`onDidReceiveMessage ` + e.type);

      const baseDir = webviewPanel.webview.asWebviewUri(
        vscode.Uri.joinPath(document.uri, ".."),
      ).toString();

      if (e.type === "ready") {
        const pasteRules = await this.loadPasteRules();

        if (document.uri.scheme === "untitled") {
          this.postMessage(webviewPanel, "init", {
            untitled: true,
            editable: true,
            baseDir,
            pasteRules,
          }, "onDidReceiveMessage " + document.uri);
        } else {
          const editable = vscode.workspace.fs.isWritableFileSystem(
            document.uri.scheme,
          );

          this.postMessage(webviewPanel, "init", {
            uri: document.uri,
            $to: "iframe",
            value: document.documentData,
            editable,
            baseDir,
            pasteRules,
          }, "onDidReceiveMessage2 " + document.uri);
        }
      }
    });
  }

  private _requestId = 1;
  private _lastSaveTime = 0;

  private readonly _callbacks = new Map<number, (response: any) => void>();
  private static readonly output = vscode.window.createOutputChannel(
    "Markdown Webview",
  );

  /** Reveal the output channel only when running under the extension debugger. */
  private showOutput(): void {
    if (this.context.extensionMode === vscode.ExtensionMode.Development) {
      MarkdownEditorProvider.output.show(true);
    }
  }

  private debug(str: string): void {
    MarkdownEditorProvider.output.appendLine(str);
    this.showOutput();
  }

  private postMessageWithResponse<R = unknown>(
    panel: vscode.WebviewPanel,
    type: string,
    body: any,
  ): Promise<R> {
    const requestId = this._requestId++;
    const p = new Promise<R>((resolve) =>
      this._callbacks.set(requestId, resolve)
    );

    this.debug(`postMessageWithResponse ` + type);

    panel.webview.postMessage({ type, requestId, body });
    return p;
  }

  private postMessage(
    panel: vscode.WebviewPanel,
    type: string,
    body: any,
    debug: string,
  ): void {
    this.debug(`postMessage ` + type + " " + debug);

    panel.webview.postMessage({ type, body });
  }

  private onMessage(document: MarkdownDocument, message: any) {
    if (!message || typeof message !== "object") {
      return;
    }

    if (
      typeof message.requestId === "number" &&
      this._callbacks.has(message.requestId)
    ) {
      const cb = this._callbacks.get(message.requestId);
      this._callbacks.delete(message.requestId);
      cb?.(message.body);
      return;
    }

    if (message.type === "webviewConsole") {
      const level = message.body?.level ?? "log";
      const text = message.body?.text ?? "";
      this.debug(`[${level}] ${text}`);
      return;
    }

    // Surface webview runtime logs/errors in extension host
    if (message.type === "webviewLog") {
      const level = message.body?.level ?? "info";
      const extra = message.body?.extra ? ` ${message.body.extra}` : "";
      const text = `[kerebron-webview:${level}] ${
        message.body?.message ?? ""
      }${extra}`;
      if (level === "error") {
        vscode.window.showErrorMessage(text);
      } else if (level === "warn") {
        vscode.window.showWarningMessage(text);
      } else {
        console.log(text);
      }
      return;
    }
  }

  private addNewDoc(document: vscode.TextDocument) {
    const json = {};

    return this.updateTextDocument(document, json);
  }

  private updateTextDocument(document: vscode.TextDocument, json: any) {
    const edit = new vscode.WorkspaceEdit();

    // Just replace the entire document every time for this example extension.
    // A more complete extension should compute minimal edits instead.
    edit.replace(
      document.uri,
      new vscode.Range(0, 0, document.lineCount, 0),
      JSON.stringify(json, null, 2),
    );

    return vscode.workspace.applyEdit(edit);
  }

  private getNonce(): string {
    const chars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let out = "";
    for (let i = 0; i < 32; i++) {
      out += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return out;
  }

  private async getWebviewContent(
    webview: vscode.Webview,
    context: vscode.ExtensionContext,
  ): Promise<string> {
    const nonce = this.getNonce();

    const htmlUri = vscode.Uri.joinPath(
      context.extensionUri,
      "extension",
      "webview",
      "customEditor.html",
    );
    const htmlBytes = await vscode.workspace.fs.readFile(htmlUri);
    const html = new TextDecoder("utf-8").decode(htmlBytes);

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        context.extensionUri,
        "dist",
        "webview",
        "main.js",
      ),
    );

    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        context.extensionUri,
        "dist",
        "webview",
        "main.css",
      ),
    );

    const wasmUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        context.extensionUri,
        "node_modules",
        "@kerebron",
        "wasm",
        "assets",
      ),
    );

    return html
      .replaceAll("__NONCE__", nonce)
      .replaceAll("__CSP_SOURCE__", webview.cspSource)
      .replaceAll("__WEBVIEW_SCRIPT_URI__", scriptUri.toString())
      .replaceAll("__WEBVIEW_STYLE_URI__", styleUri.toString())
      .replaceAll("__WASM_BASE_URL__", wasmUri.toString());
  }

  private async promptSearch(): Promise<
    | {
      search: string;
      replace: string;
      caseSensitive: boolean;
      regexp: boolean;
      wholeWord: boolean;
    }
    | undefined
  > {
    const search = await vscode.window.showInputBox({
      prompt: "Find",
      value: this.lastSearch?.search,
      placeHolder: "Search string or regex",
    });
    if (search === undefined) return undefined;

    const replace = await vscode.window.showInputBox({
      prompt: "Replace with",
      value: this.lastSearch?.replace ?? "",
      placeHolder: "Replacement text",
    });
    if (replace === undefined) return undefined;

    const caseSensitive = (await vscode.window.showQuickPick(["No", "Yes"], {
      placeHolder: "Case sensitive?",
    })) === "Yes";
    const regexp = (await vscode.window.showQuickPick(["No", "Yes"], {
      placeHolder: "Regular expression?",
    })) === "Yes";
    const wholeWord = (await vscode.window.showQuickPick(["No", "Yes"], {
      placeHolder: "Whole word only?",
    })) === "Yes";

    const q = { search, replace, caseSensitive, regexp, wholeWord };
    this.lastSearch = q;
    return q;
  }

  private async runFind(): Promise<void> {
    const panel = this.getActivePanel();
    if (!panel) return;
    const q = await this.promptSearch();
    if (!q) return;
    this.postMessage(panel, "find", { $to: "iframe", ...q }, "find");
  }

  private async runReplace(): Promise<void> {
    const panel = this.getActivePanel();
    if (!panel) return;
    const q = await this.promptSearch();
    if (!q) return;
    this.postMessage(panel, "replace", { $to: "iframe", ...q }, "replace");
  }

  private runFindNext(): void {
    const panel = this.getActivePanel();
    if (!panel || !this.lastSearch) return;
    this.postMessage(panel, "findNext", { $to: "iframe" }, "findNext");
  }

  private runFindPrev(): void {
    const panel = this.getActivePanel();
    if (!panel || !this.lastSearch) return;
    this.postMessage(panel, "findPrev", { $to: "iframe" }, "findPrev");
  }

  private runReplaceNext(): void {
    const panel = this.getActivePanel();
    if (!panel || !this.lastSearch) return;
    this.postMessage(panel, "replaceNext", { $to: "iframe" }, "replaceNext");
  }

  private runReplaceAll(): void {
    const panel = this.getActivePanel();
    if (!panel || !this.lastSearch) return;
    this.postMessage(panel, "replaceAll", { $to: "iframe" }, "replaceAll");
  }

  private async exportToPdf(): Promise<void> {
    const panel = this.getActivePanel();
    if (!panel) return;
    this.postMessage(panel, "printPdf", { $to: "iframe" }, "printPdf");
  }

  private async openBuiltinEditor(uri: vscode.Uri): Promise<void> {
    if (!uri) {
      vscode.window.showErrorMessage('No document URI');
      return;
    }
    
    await vscode.commands.executeCommand(
      'vscode.openWith',
      uri,
      'default',
      vscode.ViewColumn.Beside
    );
  }

}

class WebviewCollection {
  private readonly _webviews = new Set<{
    readonly resource: string;
    readonly webviewPanel: vscode.WebviewPanel;
  }>();

  public *get(uri: vscode.Uri): Iterable<vscode.WebviewPanel> {
    const key = uri.toString();
    for (const entry of this._webviews) {
      if (entry.resource === key) {
        yield entry.webviewPanel;
      }
    }
  }

  public add(uri: vscode.Uri, webviewPanel: vscode.WebviewPanel) {
    const entry = { resource: uri.toString(), webviewPanel };
    this._webviews.add(entry);

    webviewPanel.onDidDispose(() => {
      this._webviews.delete(entry);
    });
  }
}
