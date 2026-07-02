import * as vscode from "vscode";

import { disposeAll } from "./dispose.js";
import { MarkdownDocument } from "./MarkdownDocument.js";

export class MarkdownEditorProvider
    implements vscode.CustomEditorProvider<MarkdownDocument> {
    public static readonly viewType = "markdownEditor";

    private readonly webviews = new WebviewCollection();

    public static register(
        context: vscode.ExtensionContext,
    ): vscode.Disposable {
        const provider = new MarkdownEditorProvider(context);
        const providerRegistration = vscode.window.registerCustomEditorProvider(
            MarkdownEditorProvider.viewType,
            provider,
        );

        return providerRegistration;
    }

    constructor(private readonly context: vscode.ExtensionContext) {}

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
        const data = await document.getFileData();
        if (cancellation.isCancellationRequested) {
            return;
        }
        await vscode.workspace.fs.writeFile(document.uri, data);
    }

    async saveCustomDocumentAs(
        document: MarkdownDocument,
        destination: vscode.Uri,
        cancellation: vscode.CancellationToken,
    ): Promise<void> {
        if (cancellation.isCancellationRequested) {
            return;
        }

        const data = await document.getFileData();

        if (cancellation.isCancellationRequested) {
            return;
        }

        await vscode.workspace.fs.writeFile(destination, data);
    }

    revertCustomDocument(
        document: MarkdownDocument,
        cancellation: vscode.CancellationToken,
    ): Thenable<void> {
        throw new Error("Method revertCustomDocument not implemented.");
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

        const data = await document.getFileData();

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
        this.output.appendLine(`openCustomDocument ` + uri);
        this.output.show(true); // optional

        const document: MarkdownDocument = await MarkdownDocument.create(
            uri,
            openContext.backupId,
            {
                getFileData: async () => {
                    this.output.appendLine(`getFileData0000 `);

                    const webviewsForDocument = Array.from(
                        this.webviews.get(document.uri),
                    );
                    if (!webviewsForDocument.length) {
                        throw new Error("Could not find webview to save for");
                    }
                    const panel = webviewsForDocument[0];

                    this.output.appendLine(`getFileData ` + uri);

                    const response = await this.postMessageWithResponse<
                        number[]
                    >(panel, "getFileData", {});
                    this.output.appendLine(
                        `/getFileData ` + JSON.stringify(response),
                    );
                    return new Uint8Array(response);
                },
            },
        );

        const listeners: vscode.Disposable[] = [];

        listeners.push(document.onDidChange((e) => {
            // Tell VS Code that the document has been edited by the use.
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
                });
            }
        }));

        document.onDidDispose(() => disposeAll(listeners));

        return document;
    }

    async resolveCustomEditor(
        document: MarkdownDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken,
    ): Promise<void> {
        this.webviews.add(document.uri, webviewPanel);

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

        webviewPanel.webview.onDidReceiveMessage((e) => {
            this.output.appendLine(`onDidReceiveMessage ` + e.type);
            this.output.show(true); // optional

            const baseDir = webviewPanel.webview.asWebviewUri(
                vscode.Uri.joinPath(document.uri, ".."),
            ).toString();

            if (e.type === "ready") {
                if (document.uri.scheme === "untitled") {
                    this.postMessage(webviewPanel, "init", {
                        untitled: true,
                        editable: true,
                        baseDir,
                    });
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
                    });
                }
            }
        });
    }

    private _requestId = 1;
    private readonly _callbacks = new Map<number, (response: any) => void>();
    private readonly output = vscode.window.createOutputChannel(
        "Markdown Webview",
    );

    private postMessageWithResponse<R = unknown>(
        panel: vscode.WebviewPanel,
        type: string,
        body: any,
    ): Promise<R> {
        const requestId = this._requestId++;
        const p = new Promise<R>((resolve) =>
            this._callbacks.set(requestId, resolve)
        );

        this.output.appendLine(`postMessageWithResponse ` + type);
        this.output.show(true); // optional

        panel.webview.postMessage({ type, requestId, body });
        return p;
    }

    private postMessage(
        panel: vscode.WebviewPanel,
        type: string,
        body: any,
    ): void {
        this.output.appendLine(`postMessage ` + type);
        this.output.show(true); // optional

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
            this.output.appendLine(`[${level}] ${text}`);
            this.output.show(true); // optional
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
