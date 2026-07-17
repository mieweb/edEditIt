# edEditIt — Plan & Progress

edEditIt is a standalone, Deno-first repository that consumes `@kerebron/*` packages
and ships a VS Code extension whose custom editor hosts Kerebron in a webview. The six
sibling repos are vendored as git submodules under `vendor/` for DRY reuse.

## Vendored submodules (`vendor/`)

| Submodule | Source | Role |
|---|---|---|
| kerebron | mieweb/kerebron | ProseMirror editor kit + extensions |
| lsp-toy | horner/lsp-toy | VS Code LSP reference shell |
| templit | mieweb/templit | Markdown ↔ HTML template engine |
| esheet | mieweb/eSheet | Form builder/renderer + field types |
| osheet | mieweb/osheet | Legacy clinical form engine (to replace) |
| yabelfish | mieweb/yabelfish | Clinical LSP / parsable data |
| hey-ozwell | mieweb/hey-ozwell | Wake-word voice entry |

## Phases

### Phase 0 — Submodules & scaffold
- [x] Add all 7 repos as submodules under `vendor/`
- [x] `scripts/bootstrap.sh` (submodule init + LFS pull)
- [x] `deno.json` workspace
- [x] VS Code extension shell (`package.json`, `client/src/extension.ts`)
- [x] `plan.md` checklist

### Phase 1 — Kerebron as Markdown editor (VS Code)
- [x] Register `CustomTextEditorProvider` for `.ededit` (Markdown content, no clash with built-in `.md`)
- [x] Bundle Kerebron `editor` + `extension-markdown` in webview
- [x] Sync document ↔ ProseMirror via `WorkspaceEdit`

### Phase 2 — osheet → markdown bridge
- [ ] Map eSheet field types → markdown via templit
- [ ] Field ↔ markdown span mapping (round-trip)
- [ ] Inline mini-eSheet + popup field editor

### Phase 3 — Easier eSheet content editing
- [ ] Inline field affordances, reorder, validation surfacing

### Phase 4 — Voice + parsable data
- [ ] 4a: hey-ozwell wake-word integration
- [ ] 4b: yabelfish modules for FHIR-aware hints

### Phase 5 — Unified LSP (DRY)
- [ ] Single LSP client serving lsp-toy + kerebron extension-lsp + yabelfish
