import * as vscode from "vscode";
import { Disposable } from "./dispose.js";

export type EditorSnapshot = Record<string, unknown>;
export type FileData = {
  data: Uint8Array;
  images: Map<string, Uint8Array>;
  snapshot?: EditorSnapshot;
};

export interface MarkdownDocumentDelegate {
  getFileData(payload: { mime?: string; isSave?: boolean; assetDir?: string }): Promise<FileData>;
}

/** The custom document owns edits; opening a hidden TextDocument is unnecessary. */
export class MarkdownDocument extends Disposable implements vscode.CustomDocument {
  private _snapshot?: EditorSnapshot;
  private _savedSnapshot?: string;
  private _revision = 0;

  private constructor(
    public readonly uri: vscode.Uri,
    private _documentData: FileData,
    private readonly delegate: MarkdownDocumentDelegate,
  ) { super(); }

  static async create(uri: vscode.Uri, backupId: string | undefined, delegate: MarkdownDocumentDelegate): Promise<MarkdownDocument> {
    const dataUri = backupId ? vscode.Uri.parse(backupId) : uri;
    const bytes = dataUri.scheme === "untitled" ? new Uint8Array() : new Uint8Array(await vscode.workspace.fs.readFile(dataUri));
    const document = new MarkdownDocument(uri, { data: bytes, images: new Map() }, delegate);
    if (backupId) {
      try {
        const backup = JSON.parse(new TextDecoder().decode(bytes));
        if (backup.ededitBackup === 1 && backup.snapshot && Array.isArray(backup.data)) {
          document._documentData.data = new Uint8Array(backup.data);
          document._snapshot = structuredClone(backup.snapshot);
          // Desktop owns the restored backup's dirty state.
        }
      } catch { /* Older backups contain plain document bytes. */ }
    }
    return document;
  }

  get documentData(): FileData { return this._documentData; }
  get snapshot(): EditorSnapshot | undefined { return this._snapshot && structuredClone(this._snapshot); }
  get revision(): number { return this._revision; }
  get isDirty(): boolean { return this._snapshot !== undefined && JSON.stringify(this._snapshot) !== this._savedSnapshot; }

  getFileData(payload: { mime?: string; isSave?: boolean; assetDir?: string }): Promise<FileData> {
    return this.delegate.getFileData(payload);
  }

  initializeSnapshot(snapshot: EditorSnapshot): void {
    if (this._snapshot !== undefined) return;
    this._snapshot = structuredClone(snapshot);
    this._savedSnapshot = JSON.stringify(snapshot);
  }

  makeEdit(snapshot: EditorSnapshot): void {
    if (this._snapshot === undefined) this.initializeSnapshot(snapshot);
    const before = this.snapshot!;
    const after = structuredClone(snapshot);
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    this._snapshot = after;
    this._revision++;
    this._onDidChange.fire({
      label: "Edit document",
      undo: () => this.restore(before),
      redo: () => this.restore(after),
    });
  }

  private restore(snapshot: EditorSnapshot): void {
    this._snapshot = structuredClone(snapshot);
    this._revision++;
    this._onDidChangeContent.fire({ snapshot: this.snapshot! });
  }

  markClean(snapshot = this.snapshot, data?: Uint8Array): void {
    this._savedSnapshot = JSON.stringify(snapshot);
    if (data) this._documentData = { data: new Uint8Array(data), images: new Map() };
  }

  replaceContents(data: Uint8Array): void {
    this._documentData = { data: new Uint8Array(data), images: new Map() };
    this._snapshot = undefined;
    this._savedSnapshot = undefined;
    this._revision++;
  }

  private readonly _onDidDispose = this._register(new vscode.EventEmitter<void>());
  readonly onDidDispose = this._onDidDispose.event;
  private readonly _onDidChangeContent = this._register(new vscode.EventEmitter<{ snapshot: EditorSnapshot }>());
  readonly onDidChangeContent = this._onDidChangeContent.event;
  private readonly _onDidChange = this._register(new vscode.EventEmitter<{ label: string; undo(): void; redo(): void }>());
  readonly onDidChange = this._onDidChange.event;

  dispose(): void { this._onDidDispose.fire(); super.dispose(); }
}
