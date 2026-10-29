const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
  }

  fire(value) { for (const listener of [...this.listeners]) listener(value); }
  dispose() { this.listeners.clear(); }
}

class CancellationError extends Error {
  constructor() { super('Cancelled'); this.name = 'CancellationError'; }
}

function uri(value) {
  const parsed = new URL(value);
  return {
    scheme: parsed.protocol.slice(0, -1),
    path: parsed.pathname,
    fsPath: parsed.pathname,
    toString: () => value,
  };
}

const encode = (value) => new TextEncoder().encode(value);
const decode = (value) => new TextDecoder().decode(value);
const writes = [];
const deleted = [];
const commands = [];
let writeHook;
let directoryHook;
let inputValue = 'needle';
let readHook;
let changedFile;

const vscode = {
  EventEmitter,
  CancellationError,
  ExtensionMode: { Production: 1, Development: 2 },
  RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
  Uri: {
    parse: uri,
    file: (value) => uri(`file://${value}`),
    joinPath: (base, ...segments) => uri(`${base.scheme}://${path.posix.join(base.path, ...segments)}`),
  },
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {} }),
    showInputBox: async () => inputValue,
  },
  commands: {
    async executeCommand(command) { commands.push(command); },
  },
  workspace: {
    createFileSystemWatcher() {
      return {
        onDidChange(callback) { changedFile = callback; return { dispose() {} }; },
        dispose() {},
      };
    },
    fs: {
      async readFile() { return readHook ? readHook() : encode('# Original\n'); },
      async writeFile(resource, data) {
        writes.push({ resource: resource.toString(), data: new Uint8Array(data) });
        if (writeHook) await writeHook(resource, data);
      },
      async createDirectory(resource) { if (directoryHook) await directoryHook(resource); },
      async delete(resource) { deleted.push(resource.toString()); },
    },
  },
};

const originalLoad = Module._load;
let MarkdownDocument;
let MarkdownEditorProvider;
try {
  Module._load = function (request, parent, isMain) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
  };
  ({ MarkdownDocument } = require('../dist/MarkdownDocument.js'));
  ({ MarkdownEditorProvider } = require('../dist/markdownEditorProvider.js'));
} finally {
  Module._load = originalLoad;
}

function snapshot(text) {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

function textOf(state) { return state.content[0].content[0].text; }

function response(state, images = new Map()) {
  return { snapshot: structuredClone(state), data: encode(textOf(state)), images };
}

async function fixture(exportHook) {
  writes.length = 0;
  deleted.length = 0;
  commands.length = 0;
  writeHook = undefined;
  directoryHook = undefined;
  readHook = undefined;
  const provider = new MarkdownEditorProvider({ extensionMode: vscode.ExtensionMode.Production });
  const payloads = [];
  let document;
  document = await MarkdownDocument.create(uri('file:///fixtures/source.md'), undefined, {
    getFileData: async (payload) => {
      payloads.push(payload);
      return exportHook ? exportHook(document, payloads.length) : response(document.snapshot);
    },
  });
  document.initializeSnapshot(snapshot('Original'));
  document.makeEdit(snapshot('First edit'));
  return { provider, document, payloads, cancellation: { isCancellationRequested: false } };
}

test('saving repeats export when an edit arrives during serialization', async () => {
  const { provider, document, payloads, cancellation } = await fixture((document, call) => {
    const exported = response(document.snapshot);
    if (call === 1) document.makeEdit(snapshot('Typed during export'));
    return exported;
  });
  await provider.saveCustomDocument(document, cancellation);
  assert.equal(payloads.length, 2);
  assert.equal(decode(writes.at(-1).data), 'Typed during export');
  assert.equal(document.isDirty, false);
  assert.equal(payloads[0].isSave, true);
  assert.equal(payloads[0].assetDir, './source.assets/');
  document.dispose();
});

test('saving repeats export when an edit arrives during disk writing', async () => {
  const { provider, document, payloads, cancellation } = await fixture();
  writeHook = async () => {
    if (writes.length === 1) document.makeEdit(snapshot('Typed during write'));
  };
  await provider.saveCustomDocument(document, cancellation);
  assert.equal(payloads.length, 2);
  assert.equal(decode(writes.at(-1).data), 'Typed during write');
  assert.equal(document.isDirty, false);
  document.dispose();
});

test('overlapping saves of one document serialize their exports and writes', async () => {
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const firstExport = new Promise((resolve) => { entered = resolve; });
  let active = 0;
  let maxActive = 0;
  const { provider, document, payloads, cancellation } = await fixture(async (document, call) => {
    active++;
    maxActive = Math.max(maxActive, active);
    if (call === 1) { entered(); await gate; }
    const result = response(document.snapshot);
    active--;
    return result;
  });
  const first = provider.saveCustomDocument(document, cancellation);
  await firstExport;
  const second = provider.saveCustomDocument(document, cancellation);
  await new Promise((resolve) => setImmediate(resolve));
  const beforeRelease = payloads.length;
  release();
  await Promise.all([first, second]);
  assert.equal(beforeRelease, 1, 'the second save must wait before requesting serialization');
  assert.equal(maxActive, 1);
  assert.equal(decode(writes.at(-1).data), 'First edit');
  assert.equal(document.isDirty, false);
  document.dispose();
});

test('cancellation during export rejects without writing or marking clean', async () => {
  let cancellation;
  const item = await fixture((document) => {
    cancellation.isCancellationRequested = true;
    return response(document.snapshot);
  });
  cancellation = item.cancellation;
  await assert.rejects(item.provider.saveCustomDocument(item.document, cancellation), CancellationError);
  assert.equal(writes.length, 0);
  assert.equal(item.document.isDirty, true);
  item.document.dispose();
});

test('cancellation during asset preparation prevents the final document write', async () => {
  const { provider, document, cancellation } = await fixture((document) => response(
    document.snapshot,
    new Map([['image.png', new Uint8Array([1, 2, 3])]]),
  ));
  directoryHook = async () => { cancellation.isCancellationRequested = true; };
  await assert.rejects(provider.saveCustomDocument(document, cancellation), CancellationError);
  assert.equal(writes.some((write) => write.resource === document.uri.toString()), false);
  assert.equal(document.isDirty, true);
  document.dispose();
});

test('failed export leaves the document dirty and allows a later save retry', async () => {
  const { provider, document, cancellation } = await fixture((document, call) => {
    if (call === 1) throw new Error('Synthetic export failure');
    return response(document.snapshot);
  });
  await assert.rejects(provider.saveCustomDocument(document, cancellation), /Synthetic export failure/);
  assert.equal(writes.length, 0);
  assert.equal(document.isDirty, true);
  await provider.saveCustomDocument(document, cancellation);
  assert.equal(document.isDirty, false);
  assert.equal(decode(writes.at(-1).data), 'First edit');
  document.dispose();
});

test('failed disk write leaves the document dirty', async () => {
  const { provider, document, cancellation } = await fixture();
  writeHook = async () => { throw new Error('Synthetic write failure'); };
  await assert.rejects(provider.saveCustomDocument(document, cancellation), /Synthetic write failure/);
  assert.equal(document.isDirty, true);
  document.dispose();
});

test('backup envelopes preserve the rich snapshot and fallback bytes', async () => {
  const { provider, document, payloads, cancellation } = await fixture();
  const rich = snapshot('Unsaved rich content');
  rich.assets = { $ededitMap: [['image.png', { bytes: [1, 2, 3] }]] };
  document.makeEdit(rich);
  const destination = uri('file:///backups/source');
  const backup = await provider.backupCustomDocument(document, { destination }, cancellation);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].resource, destination.toString());
  const envelope = JSON.parse(decode(writes[0].data));
  assert.equal(envelope.ededitBackup, 1);
  assert.deepEqual(envelope.snapshot, rich);
  assert.equal(decode(new Uint8Array(envelope.data)), '# Original\n');
  assert.equal(payloads.length, 0, 'backup must not require a live webview to export');
  assert.equal(document.isDirty, true, 'a backup must not mark the source document saved');
  assert.equal(backup.id, destination.toString());
  await backup.delete();
  assert.deepEqual(deleted, [destination.toString()]);
  document.dispose();
});

test('Find uses the tracked active custom-editor panel', async () => {
  const { provider, document } = await fixture();
  const messages = [];
  const panel = { active: true, webview: { postMessage: async (message) => { messages.push(message); return true; } } };
  provider.activePanel = panel;
  assert.equal(provider.getActivePanel(), panel);
  inputValue = 'needle';
  await provider.runFind();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'find');
  assert.equal(messages[0].body.$to, 'iframe');
  assert.equal(messages[0].body.search, 'needle');
  panel.active = false;
  assert.equal(provider.getActivePanel(), undefined);
  await provider.runFind();
  assert.equal(messages.length, 1, 'an inactive panel must not receive Find commands');
  document.dispose();
});

test('webview undo and redo requests route to Desktop document history', async () => {
  const { provider, document } = await fixture();
  provider.onMessage(document, { type: 'undo' });
  provider.onMessage(document, { type: 'redo' });
  assert.deepEqual(commands, ['undo', 'redo']);
  document.dispose();
});

async function watchedFixture() {
  const initial = await fixture();
  initial.document.dispose();
  const provider = new MarkdownEditorProvider({ extensionMode: vscode.ExtensionMode.Production });
  const document = await provider.openCustomDocument(uri('file:///fixtures/watched.md'), {}, {});
  document.initializeSnapshot(snapshot('Original'));
  document.makeEdit(snapshot('Saved edit'));
  document.getFileData = async () => response(document.snapshot);
  return { provider, document, cancellation: { isCancellationRequested: false } };
}

test('a file change arriving during save is checked after the write completes', async () => {
  const { provider, document, cancellation } = await watchedFixture();
  writeHook = async () => {
    readHook = () => encode('External edit after write');
    await changedFile();
    assert.equal(textOf(document.snapshot), 'Saved edit', 'never replace a document during export');
  };
  await provider.saveCustomDocument(document, cancellation);
  assert.equal(decode(document.documentData.data), 'External edit after write');
  assert.equal(document.isDirty, false);
  document.dispose();
});

test('the own save event retains the native snapshot and undo revision', async () => {
  const { provider, document, cancellation } = await watchedFixture();
  const revision = document.revision;
  writeHook = async (_resource, bytes) => {
    readHook = () => new Uint8Array(bytes);
    await changedFile();
  };
  await provider.saveCustomDocument(document, cancellation);
  assert.equal(decode(document.documentData.data), 'Saved edit');
  assert.equal(textOf(document.snapshot), 'Saved edit');
  assert.equal(document.revision, revision);
  assert.equal(document.isDirty, false);
  document.dispose();
});

test('external changes preserve a dirty document until its owner saves', async () => {
  const { provider, document, cancellation } = await watchedFixture();
  readHook = () => encode('External content');
  await changedFile();
  assert.equal(textOf(document.snapshot), 'Saved edit');
  assert.equal(document.isDirty, true);
  writeHook = async (_resource, bytes) => { readHook = () => new Uint8Array(bytes); };
  await provider.saveCustomDocument(document, cancellation);
  assert.equal(decode(document.documentData.data), 'Saved edit');
  assert.equal(document.isDirty, false);
  document.dispose();
});

test('external reload sends a plain typed array across the native webview transport', async () => {
  const { provider, document } = await fixture();
  const messages = [];
  const panel = { onDidDispose: () => ({ dispose() {} }), webview: {
    asWebviewUri: value => value,
    postMessage: async message => { messages.push(message); return true; },
  } };
  provider.webviews.add(document.uri, panel);
  const bytes = Buffer.from('External disk content');
  provider.reloadDocument(document, bytes);
  bytes.fill(0);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'init');
  assert.equal(messages[0].body.$to, 'iframe');
  assert.equal(Buffer.isBuffer(messages[0].body.value), false, 'Buffer.toJSON bypasses typed-array transport');
  assert.equal(messages[0].body.value.constructor.name, 'Uint8Array');
  assert.equal(decode(messages[0].body.value), 'External disk content');
  document.dispose();
});
