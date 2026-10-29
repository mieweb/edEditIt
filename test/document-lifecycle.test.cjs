const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
  }

  fire(value) {
    for (const listener of [...this.listeners]) listener(value);
  }

  dispose() {
    this.listeners.clear();
  }
}

function uri(value) {
  return {
    scheme: value.slice(0, value.indexOf(':')),
    toString: () => value,
  };
}

const files = new Map();
const reads = [];
const vscode = {
  EventEmitter,
  Uri: { parse: uri },
  workspace: {
    fs: {
      async readFile(resource) {
        reads.push(resource.toString());
        assert.ok(files.has(resource.toString()), `Unexpected file read: ${resource}`);
        return files.get(resource.toString());
      },
    },
  },
};

// The document model only uses these VS Code primitives. Keeping the stub at
// the module boundary exercises the real compiled implementation without an
// extension host or a second text-document model.
const originalLoad = Module._load;
let MarkdownDocument;
try {
  Module._load = function (request, parent, isMain) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
  };
  ({ MarkdownDocument } = require('../dist/MarkdownDocument.js'));
} finally {
  Module._load = originalLoad;
}

const encode = (value) => new TextEncoder().encode(value);
const decode = (value) => new TextDecoder().decode(value);

async function createDocument(name = 'source.md', backupId) {
  const resource = uri(`file:///fixtures/${name}`);
  files.set(resource.toString(), encode('# Original\n'));
  return MarkdownDocument.create(resource, backupId, {
    getFileData: async () => ({ data: encode('# Exported\n'), images: new Map() }),
  });
}

function snapshot(text) {
  return {
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [{ type: 'text', text }],
    }],
    assets: { $ededitMap: [['image.png', { bytes: [1, 2, 3] }]] },
  };
}

test('visual edits immediately emit a custom-document edit and become dirty', async () => {
  const document = await createDocument();
  const edits = [];
  const original = snapshot('Original');
  document.onDidChange((event) => edits.push(event));
  document.initializeSnapshot(original);
  assert.equal(document.isDirty, false);
  assert.equal(edits.length, 0, 'initial rendering must not create an undo entry');

  const changed = snapshot('Changed');
  document.makeEdit(changed);
  assert.equal(document.isDirty, true, 'dirty state must not wait for save or debounce');
  assert.deepEqual(document.snapshot, changed);
  assert.equal(edits.length, 1);
  assert.equal(typeof edits[0].label, 'string');
  assert.equal(typeof edits[0].undo, 'function');
  assert.equal(typeof edits[0].redo, 'function');
  document.dispose();
});

test('host undo and redo restore snapshots and notify the visual editor', async () => {
  const document = await createDocument();
  const edits = [];
  const updates = [];
  const original = snapshot('Original');
  const first = snapshot('First edit');
  const second = snapshot('Second edit');
  document.initializeSnapshot(original);
  document.onDidChange((event) => edits.push(event));
  document.onDidChangeContent((event) => updates.push(event.snapshot));
  document.makeEdit(first);
  document.makeEdit(second);

  await edits[1].undo();
  assert.deepEqual(document.snapshot, first);
  assert.deepEqual(updates.at(-1), first);
  assert.equal(document.isDirty, true);
  await edits[0].undo();
  assert.deepEqual(document.snapshot, original);
  assert.deepEqual(updates.at(-1), original);
  assert.equal(document.isDirty, false);
  await edits[0].redo();
  await edits[1].redo();
  assert.deepEqual(document.snapshot, second);
  assert.deepEqual(updates.at(-1), second);
  assert.equal(document.isDirty, true);
  assert.equal(edits.length, 2, 'undo/redo must not register new user edits');
  document.dispose();
});

test('undoing to the saved snapshot clears dirty state; redo makes it dirty again', async () => {
  const document = await createDocument();
  const edits = [];
  document.initializeSnapshot(snapshot('Original'));
  document.onDidChange((event) => edits.push(event));
  document.makeEdit(snapshot('Saved edit'));
  document.markClean();
  assert.equal(document.isDirty, false);
  document.makeEdit(snapshot('Later edit'));
  assert.equal(document.isDirty, true);

  await edits[1].undo();
  assert.equal(document.isDirty, false);
  await edits[1].redo();
  assert.equal(document.isDirty, true);
  await edits[1].undo();
  await edits[0].undo();
  assert.equal(document.isDirty, true, 'the original content differs from the latest saved file');
  document.dispose();
});

test('a save completing after a later edit only marks its captured snapshot clean', async () => {
  const document = await createDocument();
  const edits = [];
  document.initializeSnapshot(snapshot('Original'));
  document.onDidChange((event) => edits.push(event));
  document.makeEdit(snapshot('Save in flight'));
  const saving = document.snapshot;
  document.makeEdit(snapshot('Typed during save'));
  document.markClean(saving);
  assert.equal(document.isDirty, true, 'later edits must remain unsaved');
  await edits[1].undo();
  assert.equal(document.isDirty, false);
  document.dispose();
});

test('identical snapshots do not create extra edits', async () => {
  const document = await createDocument();
  const edits = [];
  const original = snapshot('Original');
  document.initializeSnapshot(original);
  document.onDidChange((event) => edits.push(event));
  document.makeEdit(structuredClone(original));
  assert.equal(edits.length, 0);
  assert.equal(document.isDirty, false);
  const changed = snapshot('Changed');
  document.makeEdit(changed);
  document.makeEdit(structuredClone(changed));
  assert.equal(edits.length, 1, 'duplicate webview messages must share one undo entry');
  document.dispose();
});

test('snapshot inputs, getters, and undo notifications cannot mutate retained state', async () => {
  const document = await createDocument();
  const original = snapshot('Original');
  const pristine = structuredClone(original);
  const edits = [];
  document.initializeSnapshot(original);
  original.content[0].content[0].text = 'Mutated input';
  original.assets.$ededitMap[0][1].bytes[0] = 99;
  assert.deepEqual(document.snapshot, pristine);

  const copy = document.snapshot;
  copy.content[0].content[0].text = 'Mutated getter';
  assert.deepEqual(document.snapshot, pristine);
  document.onDidChange((event) => edits.push(event));
  const changed = snapshot('Changed');
  const expected = structuredClone(changed);
  document.makeEdit(changed);
  changed.content[0].content[0].text = 'Mutated edit';
  assert.deepEqual(document.snapshot, expected);
  document.onDidChangeContent((event) => {
    event.snapshot.content[0].content[0].text = 'Mutated notification';
  });
  await edits[0].undo();
  assert.deepEqual(document.snapshot, pristine);
  await edits[0].redo();
  assert.deepEqual(document.snapshot, expected);
  document.dispose();
});

test('backup restoration prefers the retained snapshot over the original disk file', async () => {
  const retained = snapshot('Unsaved backup content');
  const backupId = 'file:///backups/document';
  const data = encode('# Unsaved backup content\n');
  files.set(backupId, encode(JSON.stringify({
    ededitBackup: 1,
    snapshot: retained,
    data: Array.from(data),
  })));
  const readsBefore = reads.length;
  const document = await createDocument('restored.md', backupId);
  assert.deepEqual(reads.slice(readsBefore), [backupId]);
  assert.deepEqual(document.snapshot, retained);
  assert.equal(decode(document.documentData.data), decode(data));
  document.dispose();
});

test('legacy raw Markdown backups remain readable', async () => {
  const backupId = 'file:///backups/legacy-document';
  files.set(backupId, encode('# Legacy unsaved content\n'));
  const document = await createDocument('legacy.md', backupId);
  assert.equal(decode(document.documentData.data), '# Legacy unsaved content\n');
  document.dispose();
});

test('untitled documents initialize without reading a file', async () => {
  const readsBefore = reads.length;
  const document = await MarkdownDocument.create(uri('untitled:Untitled-1'), undefined, {
    getFileData: async () => ({ data: encode('Draft'), images: new Map() }),
  });
  assert.equal(reads.length, readsBefore);
  assert.equal(document.documentData.data.length, 0);
  document.initializeSnapshot(snapshot(''));
  assert.equal(document.isDirty, false);
  document.makeEdit(snapshot('Draft'));
  assert.equal(document.isDirty, true);
  document.dispose();
});

test('revert replaces cached bytes and initializes a new clean baseline', async () => {
  const document = await createDocument();
  document.initializeSnapshot(snapshot('Original'));
  document.makeEdit(snapshot('Unsaved edit'));
  const reverted = encode('# External disk version\n');
  document.replaceContents(reverted);
  assert.equal(decode(document.documentData.data), decode(reverted));
  document.initializeSnapshot(snapshot('External disk version'));
  assert.equal(document.isDirty, false);
  document.makeEdit(snapshot('A new edit'));
  assert.equal(document.isDirty, true);
  document.dispose();
});
