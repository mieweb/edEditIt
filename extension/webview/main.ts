import { CoreEditor } from "@kerebron/editor";
import { AdvancedEditorKit } from "@kerebron/editor-kits/AdvancedEditorKit";
import { createAssetLoad } from "@kerebron/wasm/web";
import { SearchQuery } from "@kerebron/editor/search";
import { debounce } from '@kerebron/editor/utilities';

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
    isVsCode: false,
    isSave: false,
    images: new Map<string, Uint8Array>()
  };
  editor.run
    .setToMarkdownUrlRewriter(async (href: string, ctx) => {
      if (ctx.type === "IMG") {
        if (!(rewriteCtx.isSave || rewriteCtx.isVsCode)) {
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
        editor.chain().search(currentSearch).findNext().run();
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
        editor.chain().replaceNext().run();
        return;
      }

      case "findNext": {
        if (!currentSearch) return;
        editor.chain().findNext().run();
        return;
      }

      case "findPrev": {
        if (!currentSearch) return;
        editor.chain().findPrev().run();
        return;
      }

      case "replaceNext": {
        if (!currentSearch) return;
        editor.chain().replaceNext().run();
        return;
      }

      case "replaceAll": {
        if (!currentSearch) return;
        editor.chain().replaceAll().run();
        return;
      }

      case "init": {
        if (body.pasteRules) {
          const yaml = editor.ci.resolve("yaml")! as any;
          const pasteRules = yaml.toJSON(yaml.parse(body.pasteRules));

          editor
            .chain()
            .setPasteRules(pasteRules)
            .run();
        }

        baseDir = (body.baseDir || "").replaceAll('%2B', '+');
        assetDir = body.assetDir || "";
        const fileLocation = body.uri?.path ?? "";
        documentTitle = fileLocation
          ? fileLocation.substring(fileLocation.lastIndexOf("/") + 1)
          : "";

        try {
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
        } catch (err) {
          console.error(
            "Failed editor init: ",
            err,
          );
          report("error", "Failed editor init: " + err.message, err);
        }
        return;
      }

      case "getFileData": {
        try {
          const mime = body.mime || "text/markdown";
          const isSave = !!body.isSave;
          
          rewriteCtx.isSave = isSave;
          rewriteCtx.images = new Map<string, Uint8Array>();

          const bytes = await editor.saveDocument(mime);

          rewriteCtx.isSave = false;

          const output = mime === "text/html"
            ? wrapHtmlDocument(documentTitle, new TextDecoder().decode(bytes))
            : bytes;

          vscode.postMessage({
            requestId: envelope.requestId,
            body: {
               data: Array.from(output),
               images: Array.from(rewriteCtx.images.entries())
            },
          });
        } catch (err) {
          report("error", "Failed to save document", err);
          vscode.postMessage({
            requestId: envelope.requestId,
            body: [],
          });
        }
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
          modifyMutex = 1;
          const mime = body.mime || "text/markdown";
          await editor.patchDocument(mime, body.value);
        } catch (err) {
          report("error", "Failed to update document" + err.message, err);
        } finally {
          modifyMutex = 0;
        }
        return;
      }
    }
  });

  const changeListener = debounce(async () => {
    if (modifyMutex) {
      return;
    }

    rewriteCtx.isVsCode = true;
    const bytes = await editor.saveDocument("text/markdown");
    rewriteCtx.isVsCode = false;

    vscode.postMessage({
      type: "update",
      body: Array.from(bytes),
    });
  }, 500);

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
