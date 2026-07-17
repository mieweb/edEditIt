import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import wasm from 'vite-plugin-wasm';
import { deno } from './vendor/kerebron/utils/vite-plugins/denoPlugin.ts';
import { generateAlias } from './vendor/kerebron/utils/vite-plugins/generateAlias.ts';

const root = fileURLToPath(new URL('./webview', import.meta.url));
const outDir = fileURLToPath(new URL('./media', import.meta.url));

// Builds the Kerebron-powered Markdown editor that runs inside the VS Code
// webview. Output lands in media/ with stable filenames so the extension host
// can reference them without hashed names.
export default defineConfig({
  root,
  base: '',
  plugins: [
    wasm(),
    deno(),
  ],
  css: {
    modules: {},
  },
  resolve: {
    alias: generateAlias(),
  },
  build: {
    outDir,
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        entryFileNames: 'webview.js',
        assetFileNames: 'webview.[ext]',
      },
    },
  },
  clearScreen: false,
});
