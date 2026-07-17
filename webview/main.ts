import { CoreEditor } from '@kerebron/editor';
import { BasicEditorKit } from '@kerebron/extension-basic-editor/BasicEditorKit';
import { ExtensionMarkdown } from '@kerebron/extension-markdown';

import '@kerebron/editor/assets/index.css';
import './main.css';

const MEDIA_TYPE = 'text/x-markdown';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

const element = document.getElementById('editor');
if (!element) {
  throw new Error('Missing #editor mount point');
}

const editor = CoreEditor.create({
  uri: 'document.md',
  element,
  editorKits: [
    new BasicEditorKit(),
    {
      name: 'markdown',
      getExtensions: () => [new ExtensionMarkdown()],
    },
  ],
});

/**
 * When `true`, the next `changed` event originates from an extension-driven
 * `loadDocument` rather than a user edit, so we must not echo it back to the
 * host (which would create an edit loop).
 */
let applyingRemoteEdit = false;
let lastText = '';
let debounceTimer: number | undefined;

async function pushEditToHost(): Promise<void> {
  const buffer = await editor.saveDocument(MEDIA_TYPE);
  const text = new TextDecoder().decode(buffer);
  if (text === lastText) {
    return;
  }
  lastText = text;
  vscode.postMessage({ type: 'edit', text });
}

editor.addEventListener('changed', () => {
  if (applyingRemoteEdit) {
    return;
  }
  if (debounceTimer !== undefined) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    void pushEditToHost();
  }, 250) as unknown as number;
});

async function setDocument(text: string): Promise<void> {
  if (text === lastText) {
    return;
  }
  lastText = text;
  applyingRemoteEdit = true;
  try {
    await editor.loadDocumentText(MEDIA_TYPE, text);
  } finally {
    applyingRemoteEdit = false;
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data;
  switch (message?.type) {
    case 'init':
    case 'update':
      void setDocument(String(message.text ?? ''));
      break;
  }
});

vscode.postMessage({ type: 'ready' });
