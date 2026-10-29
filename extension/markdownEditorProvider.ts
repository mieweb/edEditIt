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
  private readonly savingDocuments = new Set<MarkdownDocument>();
  private readonly saveQueues = new WeakMap<MarkdownDocument, Promise<void>>();
  private readonly reloadAfterSave = new WeakMap<MarkdownDocument, () => Promise<void>>();
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
      { webviewOptions: { retainContextWhenHidden: true } },
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
    return this.activePanel?.active ? this.activePanel : undefined;
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
    await this.writeDocument(document, document.uri, cancellation);
  }

  private assetPaths(uri: vscode.Uri): { directory?: vscode.Uri; relative: string } {
    const filename = path.basename(uri.fsPath);
    if (filename === "index.md") return { directory: vscode.Uri.joinPath(uri, ".."), relative: "./" };
    if (/\.(?:md|ededit)$/i.test(filename)) {
      const name = filename.replace(/\.(?:md|ededit)$/i, ".assets");
      return { directory: vscode.Uri.joinPath(uri, "..", name), relative: "./" + name + "/" };
    }
    return { relative: "" };
  }

  private async writeDocument(document: MarkdownDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
    const previous = this.saveQueues.get(document) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => this.persistDocument(document, destination, cancellation));
    this.saveQueues.set(document, task);
    try { await task; }
    finally { if (this.saveQueues.get(document) === task) this.saveQueues.delete(document); }
  }

  private async persistDocument(document: MarkdownDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
    const mime = this.mimeFromUri(destination);
    this.assertExportable(mime);
    const assets = this.assetPaths(destination);
    this.savingDocuments.add(document);
    try {
      // Include edits that arrive while exporting/writing before Desktop records its save point.
      while (!cancellation.isCancellationRequested) {
        const response = await document.getFileData({ mime, isSave: true, assetDir: assets.relative });
        if (cancellation.isCancellationRequested) throw new vscode.CancellationError();
        if (assets.directory && response.images.size) {
          await vscode.workspace.fs.createDirectory(assets.directory);
          for (const [name, bytes] of response.images) {
            if (cancellation.isCancellationRequested) throw new vscode.CancellationError();
            await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(assets.directory, name), bytes);
          }
        }
        if (cancellation.isCancellationRequested) throw new vscode.CancellationError();
        await vscode.workspace.fs.writeFile(destination, response.data);
        if (cancellation.isCancellationRequested) throw new vscode.CancellationError();
        if (JSON.stringify(response.snapshot) === JSON.stringify(document.snapshot)) {
          document.markClean(response.snapshot, response.data);
          return;
        }
      }
      throw new vscode.CancellationError();
    } finally {
      this.savingDocuments.delete(document);
      await this.reloadAfterSave.get(document)?.();
    }
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
    await this.writeDocument(document, destination, cancellation);
  }

  async revertCustomDocument(document: MarkdownDocument, cancellation: vscode.CancellationToken): Promise<void> {
    if (cancellation.isCancellationRequested) throw new vscode.CancellationError();
    const bytes = document.uri.scheme === "untitled" ? new Uint8Array() : await vscode.workspace.fs.readFile(document.uri);
    if (cancellation.isCancellationRequested) throw new vscode.CancellationError();
    this.reloadDocument(document, bytes);
  }

  private reloadDocument(document: MarkdownDocument, bytes: Uint8Array): void {
    document.replaceContents(bytes);
    for (const panel of this.webviews.get(document.uri)) {
      this.postMessage(panel, "init", {
        // workspace.fs can return a Node Buffer. Its toJSON runs before the
        // webview serializer, so send the document's plain Uint8Array copy.
        $to: "iframe", uri: document.uri, value: document.documentData.data, editable: true,
        baseDir: panel.webview.asWebviewUri(vscode.Uri.joinPath(document.uri, "..")).toString(),
        assetDir: this.assetPaths(document.uri).relative,
      }, "revertCustomDocument");
    }
  }

  async backupCustomDocument(document: MarkdownDocument, context: vscode.CustomDocumentBackupContext, cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
    if (cancellation.isCancellationRequested) throw new vscode.CancellationError();
    // Rich snapshots keep embedded image bytes and metadata even before a normal save.
    const bytes = new TextEncoder().encode(JSON.stringify({
      ededitBackup: 1, snapshot: document.snapshot, data: Array.from(document.documentData.data),
    }));
    await vscode.workspace.fs.writeFile(context.destination, bytes);
    return {
      id: context.destination.toString(),
      delete: async () => { try { await vscode.workspace.fs.delete(context.destination); } catch { /* already removed */ } },
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
        getFileData: async (payload: { mime?: string; isSave?: boolean; assetDir?: string }) => {
          const webviewsForDocument = Array.from(
            this.webviews.get(document.uri),
          );
          if (!webviewsForDocument.length) {
            throw new Error("Could not find webview to save for");
          }
          const panel = webviewsForDocument[0];

          const response = await this.postMessageWithResponse<
            { data: Uint8Array, images: Array<[string, Uint8Array]>, snapshot: Record<string, unknown> }
          >(panel, "getFileData", {
            $to: "iframe",
            mime: payload?.mime ?? "text/markdown",
            isSave: !!payload?.isSave,
            assetDir: payload.assetDir,
          });

          response.data = new Uint8Array(response.data);

          const images = new Map<string, Uint8Array>(
            response.images.map(([name, bytes]: [string, Uint8Array]) => [
              name,
              new Uint8Array(bytes),
            ])
          );

          return { data: response.data, images, snapshot: response.snapshot };
        },
      },
    );

    const listeners: vscode.Disposable[] = [];

    listeners.push(document.onDidChange((e) => {
      this._onDidChangeCustomDocument.fire({
        document,
        ...e,
      });
    }));

    listeners.push(document.onDidChangeContent((e) => {
      for (const panel of this.webviews.get(document.uri)) {
        this.postMessage(panel, "restore", { $to: "iframe", snapshot: e.snapshot }, "undo/redo");
      }
    }));

    if (document.uri.scheme === "file") {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(uri, ".."), path.basename(uri.fsPath)));
      let reloading = false;
      let reloadPending = false;
      const reload = async () => {
        if (!reloadPending || reloading || document.isDirty || this.savingDocuments.has(document)) return;
        reloading = true;
        try {
          while (reloadPending && !document.isDirty && !this.savingDocuments.has(document)) {
            reloadPending = false;
            const revision = document.revision;
            const bytes = await vscode.workspace.fs.readFile(uri);
            if (document.isDirty || document.revision !== revision) return;
            const current = document.documentData.data;
            if (bytes.length === current.length && bytes.every((value, index) => value === current[index])) continue;
            this.reloadDocument(document, bytes);
          }
        } catch (error) { this.debug("External reload failed: " + String(error)); }
        finally { reloading = false; }
      };
      this.reloadAfterSave.set(document, reload);
      listeners.push(watcher, watcher.onDidChange(async () => {
        reloadPending = true;
        await reload();
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

      const filename = path.basename(document.uri.fsPath);

      let assetDir = '';
      if (filename === 'index.md') {
        assetDir = './';
      } else if (/\.(?:md|ededit)$/i.test(filename)) {
        assetDir = './' + filename.replace(/\.(?:md|ededit)$/i, '.assets') + '/';
      }

      if (e.type === "ready") {
        const pasteRules = await this.loadPasteRules();

        if (document.uri.scheme === "untitled") {
          this.postMessage(webviewPanel, "init", {
            $to: "iframe",
            uri: document.uri,
            value: new Uint8Array(),
            snapshot: document.snapshot,
            untitled: true,
            editable: true,
            baseDir,
            assetDir,
            pasteRules,
          }, "onDidReceiveMessage " + document.uri);
        } else {
          const editable = vscode.workspace.fs.isWritableFileSystem(
            document.uri.scheme,
          );

          this.postMessage(webviewPanel, "init", {
            uri: document.uri,
            $to: "iframe",
            value: document.documentData.data,
            snapshot: document.snapshot,
            editable,
            baseDir,
            assetDir,
            pasteRules,
          }, "onDidReceiveMessage2 " + document.uri);
        }
      }
    });
  }

  private _requestId = 1;

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
    return new Promise<R>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); disposal.dispose(); this._callbacks.delete(requestId); };
      const fail = (error: Error) => { cleanup(); reject(error); };
      const timer = setTimeout(() => fail(new Error("Editor did not respond to " + type)), 20000);
      const disposal = panel.onDidDispose(() => fail(new Error("Editor closed during " + type)));
      this._callbacks.set(requestId, (response) => {
        cleanup();
        if (response?.error) reject(new Error(response.error));
        else resolve(response);
      });
      panel.webview.postMessage({ type, requestId, body }).then(
        accepted => { if (!accepted) fail(new Error("Editor could not receive " + type)); },
        error => fail(error),
      );
    });
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

    if (message.type === "initialized" && message.body?.snapshot) {
      document.initializeSnapshot(message.body.snapshot);
      return;
    }
    if (message.type === "edit" && message.body?.after) {
      document.initializeSnapshot(message.body.before);
      document.makeEdit(message.body.after);
      return;
    }
    if (message.type === "undo" || message.type === "redo") {
      void vscode.commands.executeCommand(message.type);
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
        this.debug(text);
      }
      return;
    }
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

  private async promptSearch(replacing = false): Promise<
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

    if (!replacing) {
      const q = { search, replace: this.lastSearch?.replace ?? "", caseSensitive: false, regexp: false, wholeWord: false };
      this.lastSearch = q;
      return q;
    }

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
    const q = await this.promptSearch(true);
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
    
    await vscode.commands.executeCommand("reopenActiveEditorWith", "default");
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
