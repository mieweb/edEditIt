import { CoreEditor } from "@kerebron/editor";
import { AdvancedEditorKit } from "@kerebron/editor-kits/AdvancedEditorKit";
import { createAssetLoad } from "@kerebron/wasm/web";
import { SearchQuery } from "@kerebron/editor/search";

import "@kerebron/editor/assets/index-light.css";
import "@kerebron/editor-kits/assets/AdvancedEditorKit.css";
import "./customEditor.css";

const vscode = acquireVsCodeApi();

function sendLog(
  level: "log" | "info" | "warn" | "error" | "trace",
  args: unknown[],
) {
  vscode.postMessage({
    type: "webviewConsole",
    body: {
      level,
      text: args.map((a) => {
        try {
          return typeof a === "string" ? a : JSON.stringify(a);
        } catch {
          return String(a);
        }
      }).join(" "),
    },
  });
}

// keep originals
const original = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  trace: console.trace.bind(console),
};

console.log = (...args) => {
  original.log(...args);
  sendLog("log", args);
};
console.info = (...args) => {
  original.info(...args);
  sendLog("info", args);
};
console.warn = (...args) => {
  original.warn(...args);
  sendLog("warn", args);
};
console.error = (...args) => {
  original.error(...args);
  sendLog("error", args);
};
console.trace = (...args) => {
  original.trace(...args);
  sendLog("trace", [new Error().stack]);
};

function report(
  level: "info" | "warn" | "error",
  message: string,
  extra?: unknown,
) {
  vscode.postMessage({
    type: "webviewLog",
    body: { level, message, extra: extra ? String(extra) : "" },
  });
}

window.addEventListener("error", (e) => {
  report(
    "error",
    `window error: ${e.message || "unknown"}`,
    `${e.filename}:${e.lineno}:${e.colno}`,
  );
});

window.addEventListener("unhandledrejection", (e) => {
  report("error", "unhandled rejection", e.reason);
});

let baseDir = "";
let assetDir = "";
let documentTitle = "";

function getExt(fileName: string) {
  const idx = fileName.lastIndexOf(".");
  if (idx > -1) {
    return fileName.substring(idx);
  }
  return "";
}

function wrapHtmlDocument(title: string, bodyHtml: string): Uint8Array {
  const safeTitle = title
    ? title.replace(/</g, "&lt;").replace(/>/g, "&gt;")
    : "Untitled";
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
</head>
<body>
${bodyHtml}
</body>
</html>
`;
  return new TextEncoder().encode(html);
}

async function printDocument(bodyHtml: string): Promise<void> {
  const html = wrapHtmlDocument(documentTitle, bodyHtml);
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.left = "-99999px";
  iframe.style.top = "0";
  iframe.style.width = "800px";
  iframe.style.height = "600px";
  iframe.style.border = "0";
  document.body.appendChild(iframe);

  try {
    const doc = iframe.contentWindow?.document;
    if (!doc) {
      report("error", "print: could not access iframe document");
      return;
    }
    doc.open();
    doc.write(html);
    doc.close();

    // Wait for images/fonts to load before printing
    await new Promise<void>((resolve) => {
      if (iframe.contentWindow?.document.readyState === "complete") {
        resolve();
      } else {
        iframe.addEventListener("load", () => resolve(), { once: true });
      }
    });

    iframe.contentWindow?.focus();
    iframe.contentWindow?.print();
  } finally {
    // Remove iframe after a delay to let the print dialog finish
    setTimeout(() => {
      if (iframe.parentNode) {
        document.body.removeChild(iframe);
      }
    }, 1000);
  }
}

let currentSearch: SearchQuery | null = null;

let modifyMutex = 0;

// VS Code's webview transport serializes messages as JSON. ProseMirror's
// document attributes include frontmatter Maps, which JSON would discard.
function takeSnapshot(editor: CoreEditor): Record<string, unknown> {
  return JSON.parse(JSON.stringify(editor.getJSON(), (_key, value) => {
    if (value instanceof Map) {
      return {
        $ededitMap: Array.from(value.entries()),
        origMap: (value as any).origMap,
        origString: (value as any).origString,
      };
    }
    return value;
  }));
}

function restoreSnapshot(snapshot: Record<string, unknown>) {
  return JSON.parse(JSON.stringify(snapshot), (_key, value) => {
    if (value && typeof value === "object" && Array.isArray(value.$ededitMap)) {
      const map = new Map(value.$ededitMap) as Map<unknown, unknown> & {
        origMap?: Map<unknown, unknown>;
        origString?: string;
      };
      if (value.origMap !== undefined) map.origMap = value.origMap;
      if (value.origString !== undefined) map.origString = value.origString;
      return map;
    }
    return value;
  });
}

try {
  const WASM_BASE_URL =
    document.head.querySelector("[name=WASM_BASE_URL]")?.getAttribute(
      "content",
    ) || "WASM_BASE_URL";
  const editor = CoreEditor.create({
    uri: "example.md", // body.uri?.path
    element: document.getElementById("editor") || undefined,
    assetLoad: createAssetLoad(WASM_BASE_URL),
    editorKits: [
      new AdvancedEditorKit(),
    ],
  });

  let previousSnapshot = takeSnapshot(editor);
  let exportQueue = Promise.resolve();

  const applySnapshot = (snapshot: Record<string, unknown>) => {
    const oldState = editor.state;
    editor.setDocument(restoreSnapshot(snapshot));
    // Match loadDocument's cloned-state transaction so URL rewriters
    // and paste rules survive rebuilding the editor state.
    editor.dispatchTransaction(editor.state.tr.setMeta("cloned", oldState));
    if (currentSearch) editor.chain().search(currentSearch).run();
    previousSnapshot = takeSnapshot(editor);
  };

  // Both the toolbar and keyboard use the native custom document history.
  // Running a second ProseMirror history would leave Desktop's dirty state
  // and undo stack out of sync with the visible document.
  editor.mergeCommandFactories({
    undo: () => (_state, dispatch) => {
      if (dispatch) vscode.postMessage({ type: "undo" });
      return true;
    },
    redo: () => (_state, dispatch) => {
      if (dispatch) vscode.postMessage({ type: "redo" });
      return true;
    },
  }, "desktopHistory");

  window.addEventListener("keydown", (event) => {
    if (event.isComposing || event.altKey || !(event.metaKey || event.ctrlKey)) return;
    const target = event.target;
    if (!(target instanceof HTMLElement) ||
      target.closest("input, textarea, select") || !target.closest(".kb-editor")) return;

    const key = event.key.toLowerCase();
    const undo = key === "z" && !event.shiftKey;
    const redo = (key === "z" && event.shiftKey) ||
      (key === "y" && event.ctrlKey && !event.shiftKey);
    if (!undo && !redo) return;

    // Stop the webview's built-in forwarding as well as the local keymap,
    // otherwise one key press can execute both histories.
    event.preventDefault();
    event.stopImmediatePropagation();
    vscode.postMessage({ type: undo ? "undo" : "redo" });
  }, { capture: true });

  editor.run
    .setFromOdtUrlRewriter(async (href, ctx) => {
      if (ctx.type === "IMG") {
        const file = ctx.filesMap[href];
        if (file) {
          const ext = getExt(href);
          if (ext) {
            // const dir = selectedFile.previewUrl + '.assets/';
            // href = dir + await generateMD5Hash(file) + ext;
          }
        }
      }
      return href;
    });

  editor.run
    .setFromMarkdownUrlRewriter(async (href, ctx) => {
      if (ctx.type === "IMG") {
        if (/^(https?:|data:|vscode-|\/)/.test(href)) {
          return href;
        }
        return new URL(href, baseDir + "/").href;
      }
      return href;
    });

  const rewriteCtx = {
    isSave: false,
    images: new Map<string, Uint8Array>()
  };
  editor.run
    .setToMarkdownUrlRewriter(async (href: string, ctx) => {
      if (ctx.type === "IMG") {
        if (!rewriteCtx.isSave) {
          return href;
        }

        if (href.startsWith('https://file+.vscode-resource.vscode-cdn.net') && href.startsWith(baseDir)) {
          href = href.substring(baseDir.length)
          if (href.startsWith('/')) {
            href = '.' + href;
          }
          return href;
        } else
        if (/^(data:)/.test(href)) {
          const base64 = href.split(',')[1];
          const binary = atob(base64);
          const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));

          const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
          const hash = [...new Uint8Array(hashBuffer)]
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');

          const match = href.match(/^data:image\/([^;,]+)/i);
          const extension = match?.[1] === 'jpeg' ? 'jpg' : match?.[1] || 'bin';

          const filename = `${hash}.${extension}`;

          if (rewriteCtx.isSave) {
            rewriteCtx.images.set(filename, bytes);
          }

          const destFile = assetDir + filename;

          return destFile;
        }
      }
      return href;
    });

  window.addEventListener("message", async (event) => {
    const envelope = event.data;
    if (!envelope || typeof envelope !== "object") return;

    const msg = envelope.body;
    if (!msg || msg.$to !== "iframe") return;

    const { type, body } = { type: envelope.type, body: msg };
    if (body.$to !== "iframe") return;

    switch (type) {
      case "find": {
        currentSearch = new SearchQuery({
          search: body.search,
          replace: body.replace ?? "",
          caseSensitive: body.caseSensitive ?? false,
          regexp: body.regexp ?? false,
          wholeWord: body.wholeWord ?? false,
        });
        editor.chain().search(currentSearch).run();
        editor.chain().findNext().run();
        editor.view.focus();
        return;
      }

      case "replace": {
        currentSearch = new SearchQuery({
          search: body.search,
          replace: body.replace ?? "",
          caseSensitive: body.caseSensitive ?? false,
          regexp: body.regexp ?? false,
          wholeWord: body.wholeWord ?? false,
        });
        editor.chain().search(currentSearch).run();
        editor.chain().replaceNext().run();
        editor.view.focus();
        return;
      }

      case "findNext": {
        if (!currentSearch) return;
        editor.chain().findNext().run();
        editor.view.focus();
        return;
      }

      case "findPrev": {
        if (!currentSearch) return;
        editor.chain().findPrev().run();
        editor.view.focus();
        return;
      }

      case "replaceNext": {
        if (!currentSearch) return;
        editor.chain().replaceNext().run();
        editor.view.focus();
        return;
      }

      case "replaceAll": {
        if (!currentSearch) return;
        editor.chain().replaceAll().run();
        editor.view.focus();
        return;
      }

      case "init": {
        // Loading converters may await WASM or image data. Prevent an edit
        // from being overwritten before the initial document is installed.
        editor.view.setProps({ editable: () => false });
        modifyMutex++;
        try {
          if (body.pasteRules) {
            const yaml = editor.ci.resolve("yaml")! as any;
            const pasteRules = yaml.toJSON(yaml.parse(body.pasteRules));

            editor.chain().setPasteRules(pasteRules).run();
          }

          baseDir = (body.baseDir || "").replaceAll('%2B', '+');
          assetDir = body.assetDir || "";
          const fileLocation = body.uri?.path ?? "";
          documentTitle = fileLocation
            ? fileLocation.substring(fileLocation.lastIndexOf("/") + 1)
            : "";
          const ext = fileLocation.split(".").pop()?.toLowerCase();
          switch (ext) {
            case "odt":
              await editor.loadDocument(
                "application/vnd.oasis.opendocument.text",
                body.value,
              );
              break;
            case "html":
            case "htm":
              await editor.loadDocument("text/html", body.value);
              break;
            default:
              await editor.loadDocument("text/markdown", body.value);
              break;
          }
          if (body.snapshot) applySnapshot(body.snapshot);
          previousSnapshot = takeSnapshot(editor);
          vscode.postMessage({ type: "initialized", body: { snapshot: previousSnapshot } });
        } catch (err) {
          report("error", "Failed editor init", err);
        } finally {
          modifyMutex--;
          editor.view.setProps({ editable: () => body.editable !== false });
        }
        return;
      }

      case "restore": {
        modifyMutex++;
        try {
          applySnapshot(body.snapshot);
          editor.view.focus();
        } catch (err) {
          report("error", "Failed to restore document", err);
        } finally {
          modifyMutex--;
        }
        return;
      }

      case "getFileData": {
        const exportDocument = async () => {
          const originalAssetDir = assetDir;
          try {
            const mime = body.mime || "text/markdown";
            const isSave = !!body.isSave;

            if (typeof body.assetDir === "string") assetDir = body.assetDir;
            rewriteCtx.isSave = isSave;
            rewriteCtx.images = new Map<string, Uint8Array>();

            const snapshot = takeSnapshot(editor);
            const bytes = await editor.saveDocument(mime);

            rewriteCtx.isSave = false;

            const output = mime === "text/html"
              ? wrapHtmlDocument(documentTitle, new TextDecoder().decode(bytes))
              : bytes;

            vscode.postMessage({
              requestId: envelope.requestId,
              body: {
                data: Array.from(output),
                images: Array.from(rewriteCtx.images.entries()),
                snapshot,
              },
            });
          } catch (err) {
            report("error", "Failed to save document", err);
            vscode.postMessage({
              requestId: envelope.requestId,
              body: { error: String(err) },
            });
          } finally {
            assetDir = originalAssetDir;
            rewriteCtx.isSave = false;
            rewriteCtx.images = new Map<string, Uint8Array>();
          }
        };
        // A converter can await image hashing. Serialize exports so Save As
        // and autosave cannot mix their image maps or destination paths.
        exportQueue = exportQueue.then(exportDocument, exportDocument);
        await exportQueue;
        return;
      }

      case "printPdf": {
        try {
          const htmlBytes = await editor.saveDocument("text/html");
          await printDocument(new TextDecoder().decode(htmlBytes));
        } catch (err) {
          report("error", "Failed to print document", err);
        }
        return;
      }

      case "update": {
        try {
          modifyMutex++;
          const mime = body.mime || "text/markdown";
          await editor.patchDocument(mime, body.value);
          previousSnapshot = takeSnapshot(editor);
          vscode.postMessage({ type: "initialized", body: { snapshot: previousSnapshot } });
        } catch (err) {
          report("error", "Failed to update document" + err.message, err);
        } finally {
          modifyMutex--;
        }
        return;
      }
    }
  });

  const changeListener = () => {
    if (modifyMutex) {
      return;
    }

    const snapshot = takeSnapshot(editor);
    const before = previousSnapshot;
    previousSnapshot = snapshot;
    vscode.postMessage({
      type: "edit",
      body: { before, after: snapshot },
    });
  };

  editor.addEventListener('changed', changeListener);

  report("info", "CoreEditor created");
} catch (err) {
  report("error", "Failed to init CoreEditor", err);
}

window.addEventListener("load", () => {
  vscode.postMessage({ type: "ready" });
});

window.addEventListener("error", () => {
  report("error", `iframe failed to load: ${window.src}`);
});

window.addEventListener("message", (event) => {
  const envelope = event.data;
  if (!envelope || typeof envelope !== "object") return;

  const msg = envelope.body;
  if (!msg || msg.$to !== "iframe") return;

  window.contentWindow?.postMessage({ type: envelope.type, body: msg }, "*");
});

window.addEventListener("message", (event) => {
  if (event.source !== window.contentWindow) return;
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.$to !== "extension") return;
  vscode.postMessage(msg);
});

async function sizeSvgImages() {
    const images = document.querySelectorAll('img[src$=".svg"]');

    for (const img of images) {
        if (img.offsetWidth !== 0) continue;

        try {
            const response = await fetch(img.src);
            const svgText = await response.text();

            const svg = new DOMParser()
                .parseFromString(svgText, 'image/svg+xml')
                .documentElement;

            const viewBox = svg.getAttribute('viewBox');
            if (!viewBox) continue;

            const [, , width] = viewBox
                .trim()
                .split(/\s+/)
                .map(Number);

            if (!width) continue;

            img.style.width = `${width}px`;
            img.style.maxWidth = '100%';
            img.style.height = 'auto';
        } catch (error) {
            console.error('Could not process SVG:', img.src, error);
        }
    }
}

setInterval(sizeSvgImages, 1000);
