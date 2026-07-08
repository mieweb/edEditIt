import * as vscode from "vscode";

import { Disposable } from "./dispose.js";

export interface MarkdownDocumentDelegate {
  getFileData(mime?: string): Promise<Uint8Array>;
}

export class MarkdownDocument extends Disposable
  implements vscode.CustomDocument {
  private readonly _uri: vscode.Uri;

  private _documentData: Uint8Array;

  private readonly _delegate: MarkdownDocumentDelegate;

  private constructor(
    uri: vscode.Uri,
    initialContent: Uint8Array,
    delegate: MarkdownDocumentDelegate,
  ) {
    super();
    this._uri = uri;
    this._delegate = delegate;
    this._documentData = initialContent;
  }

  public async getFileData(mime?: string): Promise<Uint8Array> {
    const data = await this._delegate.getFileData(mime);
    this._documentData = data;
    return data;
  }

  static async create(
    uri: vscode.Uri,
    backupId: string | undefined,
    delegate: MarkdownDocumentDelegate,
  ): Promise<MarkdownDocument | PromiseLike<MarkdownDocument>> {
    const dataFile = typeof backupId === "string"
      ? vscode.Uri.parse(backupId)
      : uri;
    const fileData = await MarkdownDocument.readFile(dataFile);
    return new MarkdownDocument(uri, fileData, delegate);
  }

  private static async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    if (uri.scheme === "untitled") {
      return new Uint8Array();
    }
    return new Uint8Array(await vscode.workspace.fs.readFile(uri));
  }

  public get uri() {
    return this._uri;
  }

  public get documentData(): Uint8Array {
    return this._documentData;
  }

  private readonly _onDidDispose = this._register(
    new vscode.EventEmitter<void>(),
  );
  /**
   * Fired when the document is disposed of.
   */
  public readonly onDidDispose = this._onDidDispose.event;

  private readonly _onDidChangeDocument = this._register(
    new vscode.EventEmitter<{
      readonly content?: Uint8Array;
    }>(),
  );

  public readonly onDidChangeContent = this._onDidChangeDocument.event;

  private readonly _onDidChange = this._register(
    new vscode.EventEmitter<{
      readonly label: string;
      undo(): void;
      redo(): void;
    }>(),
  );

  public readonly onDidChange = this._onDidChange.event;

  private _dirty = false;

  public get isDirty(): boolean {
    return this._dirty;
  }

  public markDirty(): void {
    this._dirty = true;
  }
  public markClean(): void {
    this._dirty = false;
  }

  dispose(): void {
    this._onDidDispose.fire();
    super.dispose();
  }
}
