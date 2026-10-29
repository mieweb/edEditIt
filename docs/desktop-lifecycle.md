# Native custom-editor lifecycle

Visual transactions belong to a VS Code custom document. Each transaction emits
a custom-document edit with immutable rich snapshots. VS Code owns dirty tabs,
save/discard/cancel prompts, and keyboard and toolbar undo/redo. The provider does
not open a hidden text document or synchronize through `WorkspaceEdit`.

Saves serialize per document and include edits that arrive during export or disk
writing. Failed or canceled saves retain dirty state. Rich backups retain Maps,
frontmatter source, and embedded images. Save As uses its destination's asset
directory. ODT export remains unsupported.

Clean external updates reload the visual view; dirty documents retain their
unsaved edits. File notifications arriving during a save are checked after the
write completes. The saved byte copy distinguishes the provider's own write from
an external update without replacing its native undo snapshot. Revert and reload
send a plain `Uint8Array`: Node Buffer's `toJSON()` bypasses VS Code's typed-array
webview transport and otherwise leaves the visual view stale.

Find tracks the active custom-editor panel and dispatches the search query before
finding or replacing a match. **Open in Text Editor** replaces the active editor
through the native reopen command.

## Validation

```sh
npm run check
npm run test:unit
npm exec -- vsce package --out /tmp/ededitit-lifecycle.vsix
```

The 33 focused regressions cover document snapshots, save serialization,
cancellation and failures, native history, external updates and transport,
backup initialization, Find, and webview protocol behavior. The native Ozwell
Desktop runner is maintained in the Desktop repository as
`scripts/test-ededitit-desktop.mjs`. It uses a compiled extension, isolated
portable application profiles, and synthetic Markdown/`.ededit` files to verify
dirty state, save prompts, undo/redo, external reload, Find, reopen, and discard
in the editor and Agents windows. It does not change existing profiles or enable
the extension in a distributed Desktop build.
