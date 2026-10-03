# edEditIt — Plan & Progress

edEditIt is a VS Code extension whose custom editor hosts Kerebron in a webview.
It consumes published `@kerebron/*` npm packages and uses esbuild and TypeScript
to build the `extension/` sources into `dist/`.

## MDY reference (`vendor/templit`)

| Reference | Source | Role |
|---|---|---|
| templit | [mieweb/templit](https://github.com/mieweb/templit) | Pinned MDY specification, samples, and implicit field-link rendering |

The only submodule is pinned to `7927953098e24b7f41e71c765bb2e87f5b9c85de`.
It provides a reproducible reference for future MDY support; the extension's
runtime and build use npm dependencies. See [docs/mdy-spec.md](docs/mdy-spec.md)
for the specification and [ticket.md](ticket.md) for the editor milestones.

## Development

Run `./scripts/bootstrap.sh` to initialize the pinned templit reference.
Run `npm ci` to install extension dependencies, then `npm run compile` to bundle
the webview and compile the extension. The entry points are
`extension/index.ts` and `extension/webview/main.ts`.

## Phases

### Phase 0 — Extension build & MDY reference
- [x] Published `@kerebron/*` npm dependencies and lockfile
- [x] esbuild webview bundle and TypeScript extension build
- [x] VS Code extension shell (`package.json`, `extension/index.ts`)
- [x] Pinned templit reference and `scripts/bootstrap.sh`
- [x] `plan.md` checklist

### Phase 1 — Kerebron editor (VS Code)
- [x] Register the custom editor for `.md`, `.ededit` (Markdown content), and `.odt`
- [x] Bundle Kerebron `CoreEditor`, `AdvancedEditorKit`, and WASM assets in the webview
- [x] Sync Markdown document ↔ editor via `WorkspaceEdit`; load ODT and save/export Markdown or HTML through the custom document provider

### Phase 2 — MDY field links & resolver editing
- [ ] Recognize and protect data-backed field links; show front matter and diagnostics
- [ ] Preserve YAML and Markdown formatting across no-op saves and field edits
- [ ] Add a resolver registry and eSheet popup editing, updating all linked spans

Templit already renders template bodies with implicit field links. Exporting a
complete `.mdy` with merged front matter and template provenance remains planned.
The detailed acceptance criteria live in [ticket.md](ticket.md).

### Phase 3 — Easier eSheet content editing
- [ ] Focus the resolver popup on the selected field and related fields
- [ ] Inline field affordances, reorder, validation surfacing

### Phase 4 — Voice + parsable data
- [ ] 4a: hey-ozwell wake-word integration
- [ ] 4b: yabelfish modules for FHIR-aware hints

### Phase 5 — Unified LSP (DRY)
- [ ] Single LSP client serving lsp-toy + kerebron extension-lsp + yabelfish
