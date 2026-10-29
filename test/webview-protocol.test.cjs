const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { webcrypto } = require('node:crypto');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

const source = readFileSync(join(__dirname, '../extension/webview/main.ts'), 'utf8');
const script = transformSync(source, { loader: 'ts', format: 'cjs' }).code;

function createWebview() {
  const messages = [];
  const listeners = new Map();
  const commands = [];
  const editorListeners = new Map();
  let currentDocument = { type: 'doc', content: [{ type: 'paragraph' }] };
  let pendingSearch;
  let activeSearch;
  class HTMLElement {
    constructor(isEditor = true, isInput = false) {
      this.isEditor = isEditor;
      this.isInput = isInput;
    }
    closest(selector) {
      if (selector === '.kb-editor') return this.isEditor ? this : null;
      return this.isInput ? this : null;
    }
  }
  const state = {
    tr: {
      setMeta(key, value) {
        this[key] = value;
        return this;
      },
    },
  };
  const editor = {
    state,
    view: { focus() {}, setProps(props) { this.props = props; } },
    run: new Proxy({}, { get: (_target, name) => (...args) => {
      if (name === 'setToMarkdownUrlRewriter') editor.toMarkdownUrlRewriter = args[0];
      return true;
    } }),
    getJSON: () => currentDocument,
    mergeCommandFactories(factories) { this.factories = factories; },
    chain() {
      const queued = [];
      const chain = new Proxy({}, {
        get(_target, name) {
          if (name === 'run') return () => {
            commands.push(queued);
            if (pendingSearch) activeSearch = pendingSearch;
            pendingSearch = undefined;
            return true;
          };
          return (...args) => {
            queued.push(name);
            if (name === 'search') pendingSearch = args[0];
            if (name === 'findNext' || name === 'replaceNext') {
              assert.ok(activeSearch, 'search must be dispatched before finding or replacing');
            }
            return chain;
          };
        },
      });
      return chain;
    },
    async loadDocument(_mime, data) {
      currentDocument = JSON.parse(new TextDecoder().decode(data));
      editorListeners.get('changed')?.();
    },
    setDocument(value) {
      currentDocument = value;
      editorListeners.get('changed')?.();
    },
    dispatchTransaction(transaction) { this.lastTransaction = transaction; },
    async saveDocument() { return new TextEncoder().encode('saved document'); },
    addEventListener(name, callback) { editorListeners.set(name, callback); },
  };
  const sandbox = {
    require(name) {
      if (name === '@kerebron/editor') return { CoreEditor: { create: () => editor } };
      if (name === '@kerebron/editor-kits/AdvancedEditorKit') return { AdvancedEditorKit: class {} };
      if (name === '@kerebron/wasm/web') return { createAssetLoad() {} };
      if (name === '@kerebron/editor/search') return { SearchQuery: class {
        constructor(options) { Object.assign(this, options); }
      } };
      if (name.endsWith('.css')) return {};
      throw new Error(`Unexpected import: ${name}`);
    },
    acquireVsCodeApi: () => ({ postMessage(message) { messages.push(message); } }),
    window: {
      addEventListener(name, callback, options) {
        const callbacks = listeners.get(name) ?? [];
        callbacks.push({ callback, options });
        listeners.set(name, callbacks);
      },
    },
    document: { head: { querySelector() {} }, getElementById() {} },
    HTMLElement,
    Map,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    atob,
    crypto: webcrypto,
    console: { log() {}, info() {}, warn() {}, error() {}, trace() {} },
    setInterval() {},
  };
  vm.runInNewContext(script, sandbox);
  assert.ok(listeners.has('message'), 'webview setup must succeed');
  messages.length = 0;
  return {
    editor, messages, commands, HTMLElement,
    async message(type, body, requestId) {
      for (const { callback } of listeners.get('message')) {
        await callback({ data: { type, requestId, body: { $to: 'iframe', ...body } } });
      }
    },
    key(event) {
      const registration = listeners.get('keydown')[0];
      assert.equal(registration.options.capture, true);
      registration.callback(event);
    },
    change(value) {
      currentDocument = value;
      editorListeners.get('changed')();
    },
    getDocument: () => currentDocument,
  };
}

test('visual edits notify native history immediately with immutable snapshots', async () => {
  const webview = createWebview();
  const baseline = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'before' }] }] };
  await webview.message('init', { value: new TextEncoder().encode(JSON.stringify(baseline)) });
  assert.equal(webview.messages.length, 1, 'loading must not emit a user edit');
  assert.equal(webview.messages[0].type, 'initialized');
  webview.messages.length = 0;
  const after = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'after' }] }] };
  webview.change(after);
  assert.equal(webview.messages[0].type, 'edit');
  assert.equal(webview.messages[0].body.before.content[0].content[0].text, 'before');
  after.content[0].content[0].text = 'mutated later';
  assert.equal(webview.messages[0].body.after.content[0].content[0].text, 'after');
});

test('restore preserves frontmatter Maps and plugin configuration without echoing edits', async () => {
  const webview = createWebview();
  const meta = new Map([['title', 'Clinical note'], ['nested', new Map([['enabled', true]])]]);
  meta.origMap = new Map([['title', 'Clinical note']]);
  meta.origString = '---\n# keep comment\ntitle: Clinical note\n---\n';
  webview.change({ type: 'doc', attrs: { meta }, content: [{ type: 'paragraph' }] });
  const snapshot = webview.messages[0].body.after;
  assert.equal(snapshot.attrs.meta.$ededitMap[0][1], 'Clinical note');
  webview.messages.length = 0;
  const oldState = webview.editor.state;
  await webview.message('restore', { snapshot });
  assert.equal(webview.messages.length, 0);
  const restored = webview.getDocument().attrs.meta;
  assert.ok(restored instanceof Map);
  assert.equal(restored.get('nested').get('enabled'), true);
  assert.equal(restored.origString, meta.origString);
  assert.equal(restored.origMap.get('title'), 'Clinical note');
  assert.equal(webview.editor.lastTransaction.cloned, oldState);
});

test('initializing a restored backup uses its rich snapshot rather than stale disk content', async () => {
  const webview = createWebview();
  const disk = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'saved on disk' }] }] };
  const backup = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'unsaved recovered content' }] }] };
  await webview.message('init', {
    value: new TextEncoder().encode(JSON.stringify(disk)), snapshot: backup,
  });
  assert.equal(webview.messages.length, 1);
  assert.equal(webview.messages[0].type, 'initialized');
  assert.equal(webview.getDocument().content[0].content[0].text, 'unsaved recovered content');
});

test('async initialization blocks editing until loaded and honors read-only files', async () => {
  const webview = createWebview();
  let finishLoad;
  const gate = new Promise(resolve => { finishLoad = resolve; });
  webview.editor.loadDocument = () => gate;
  const initialize = webview.message('init', { value: new Uint8Array(), editable: true });
  assert.equal(webview.editor.view.props.editable(), false);
  finishLoad();
  await initialize;
  assert.equal(webview.editor.view.props.editable(), true);
  await webview.message('init', { value: new Uint8Array(), editable: false });
  assert.equal(webview.editor.view.props.editable(), false);
});

test('keyboard and toolbar dispatch one native undo or redo rather than local history', () => {
  const webview = createWebview();
  for (const [key, shiftKey, ctrlKey, expected] of [
    ['z', false, false, 'undo'], ['Z', true, false, 'redo'],
    ['z', false, true, 'undo'], ['y', false, true, 'redo'],
  ]) {
    let prevented = false;
    let stopped = false;
    webview.key({ key, shiftKey, ctrlKey, metaKey: !ctrlKey, target: new webview.HTMLElement(),
      preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; } });
    assert.equal(prevented, true);
    assert.equal(stopped, true);
    assert.equal(webview.messages.pop().type, expected);
  }
  webview.editor.factories.undo()({}, undefined);
  assert.equal(webview.messages.length, 0, 'toolbar enable checks must not undo');
  webview.editor.factories.undo()({}, () => {});
  webview.editor.factories.redo()({}, () => {});
  assert.equal(webview.messages.map(message => message.type).join(','), 'undo,redo');
  assert.equal(webview.commands.length, 0, 'local history must not run');
});

test('typing fields retain their own keyboard undo', () => {
  const webview = createWebview();
  webview.key({ key: 'z', metaKey: true, target: new webview.HTMLElement(true, true),
    preventDefault() { assert.fail('input undo must not be intercepted'); },
    stopImmediatePropagation() { assert.fail('input undo must not be intercepted'); } });
  assert.equal(webview.messages.length, 0);
});

test('Find and Replace install the new query before selecting matches', async () => {
  const webview = createWebview();
  await webview.message('find', { search: 'first' });
  await webview.message('replace', { search: 'second', replace: 'new text' });
  assert.equal(JSON.stringify(webview.commands), JSON.stringify([
    ['search'], ['findNext'], ['search'], ['replaceNext'],
  ]));
});

test('save response identifies the exported snapshot and errors reject instead of empty data', async () => {
  const webview = createWebview();
  const expected = webview.getDocument();
  await webview.message('getFileData', {}, 10);
  assert.equal(webview.messages[0].requestId, 10);
  assert.equal(JSON.stringify(webview.messages[0].body.snapshot), JSON.stringify(expected));
  webview.messages.length = 0;
  webview.editor.saveDocument = async () => { throw new Error('converter failed'); };
  await webview.message('getFileData', {}, 11);
  const response = webview.messages.find(message => message.requestId === 11);
  assert.match(response.body.error, /converter failed/);
  assert.equal(response.body.data, undefined);
});

test('queued exports keep Save As assets separate and preserve the original destination', async () => {
  const webview = createWebview();
  await webview.message('init', {
    value: new TextEncoder().encode(JSON.stringify(webview.getDocument())), assetDir: './old.assets/',
  });
  webview.messages.length = 0;
  let finishFirst;
  const gate = new Promise(resolve => { finishFirst = resolve; });
  let calls = 0;
  webview.editor.saveDocument = async () => {
    calls++;
    if (calls === 1) await gate;
    const imagePath = await webview.editor.toMarkdownUrlRewriter('data:image/png;base64,AQID', { type: 'IMG' });
    return new TextEncoder().encode(imagePath);
  };
  const first = webview.message('getFileData', { isSave: true, assetDir: './new.assets/' }, 20);
  const second = webview.message('getFileData', { isSave: true }, 21);
  await Promise.resolve();
  assert.equal(calls, 1, 'second export must wait for the first converter');
  finishFirst();
  await Promise.all([first, second]);
  const responses = webview.messages.filter(message => message.requestId);
  assert.equal(responses.length, 2);
  assert.match(new TextDecoder().decode(Uint8Array.from(responses[0].body.data)), /^\.\/new\.assets\//);
  assert.match(new TextDecoder().decode(Uint8Array.from(responses[1].body.data)), /^\.\/old\.assets\//);
  assert.equal(responses[0].body.images.length, 1);
  assert.equal(responses[1].body.images.length, 1);
});
