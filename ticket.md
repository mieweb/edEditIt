# Support the MDY standard: field links + resolver-driven editing (eSheet first)

## Summary

Implement the [MDY specification](https://github.com/mieweb/templit/blob/main/doc/mdy-specification.md)
in Kerebron: YAML front matter is the canonical data, and body spans written as
`[display](#field_id)` are **field links** — protected, addressable views of that
data. Editing a field link should go through a **resolver** component (eSheet is
the initial milestone), not free typing.

Runnable samples (`.mdyt` template / `.mdy` flattened pairs):
[templit/samples](https://github.com/mieweb/templit/tree/main/samples) — see
`esheet.mdy` for the target document shape of this ticket.

## Background

- A field link is a markdown link whose target is `#<id>` (or `mdy:<id>`) where
  `<id>` exists in the front-matter index (spec §3–4).
- Spec §4 sketches the editing semantics: a `fieldLink` mark (non-inclusive,
  id-only), chip-style rendering, data-first editing, unlink-on-direct-edit.
- templit already renders `.mdyt` → `.mdy` with implicit field links
  (`{{weight}}` → `[198 lb](#weight)`), so documents arrive pre-linked.

## Milestone 1 — Protected field-link spans (read layer)

Show the user which spans are data-backed and protect them from accidental
free-text edits.

- [ ] Parse front matter on document load; build the field index (`id → value`)
- [ ] Recognize `[display](#id)` / `[display](mdy:id)` links whose id is in the
      index and apply a `fieldLink` mark (non-inclusive; stores only the id)
- [ ] Render field links as visually distinct chips (background/underline +
      cursor affordance; ARIA label announcing "linked field: <id>")
- [ ] Block or intercept direct typing inside a chip (Phase 1: read-only span;
      the unlink flow comes later)
- [ ] Diagnostics: dangling link (id not in front matter) and orphan data
      (id never referenced) surfaced as decorations
- [ ] Serialization round-trips losslessly — no-op open/save is **byte-identical**
      across all templit samples (empty git diff), and the mark re-emits the
      exact `[display](#id)` markdown (spec §9.3)
- [ ] Add a frontmatter viewer so users can see the underlying YAML data for the document.  Simple text editing is fine, but the primary goal is read-only visibility.

## Milestone 2 — Resolver pop-up editing (write layer)

Click a chip → edit the *data* → the document updates.

- [ ] Define the `MdyResolver` interface (spec §5): `detect / index / display /
      component? / validate?`
- [ ] Resolver registry on the editor instance (host installs resolvers;
      documents can never inject one)
- [ ] Chip activation (click / Enter) opens the resolver's `component` in a
      pop-up anchored to the chip
- [ ] eSheet resolver: renders the eSheet field editor for the linked field
      (fieldType, question, unit, inputType from the front matter definition)
- [ ] On commit: update front matter → recompute `display` → replace chip text
      in one transaction (undo-friendly)
- [ ] All chips bound to the same id update together
- [ ] Front-matter writes go through a comment/format-preserving YAML API
      (`yaml` `parseDocument`/`setIn`) — never load→dump. YAML comments, key
      order, quoting style, and blank lines survive edits
- [ ] Minimal git diffs: a resolver commit diffs as only the changed scalar
      line(s) in front matter plus the changed chip display text — unedited
      lines are preserved byte-for-byte
- [ ] Direct-edit escape hatch: typing into a chip unlinks it (removes the
      mark, leaves plain text) and raises the orphan-data diagnostic
- [ ] Generic YAML fallback resolver (plain input) so documents without eSheet
      definitions still get pop-up editing

## Milestone 3 — Focused eSheet rendering (mental-tax reduction)

When editing one field (e.g. systolic), don't show the whole eSheet — show the
sheet collapsed/filtered to the field that matters, with just enough context.

- [ ] Pass a focus target from the resolver pop-up into the eSheet component
      (e.g. `focusField: "systolic"`)
- [ ] eSheet renders with non-focused sections collapsed/hidden; the focused
      field is expanded, scrolled into view, and receives input focus
- [ ] Related fields (same group/section, e.g. diastolic next to systolic) stay
      visible for context; everything else is one click away (expand affordance)
- [ ] Keyboard flow: pop-up opens → focused field editable immediately →
      Esc cancels, Enter/blur commits

> **Note:** the collapse/focus behavior likely lands as a companion ticket in
> [mieweb/eSheet](https://github.com/mieweb/eSheet) — "accept a `focusField`
> (or focus selector) prop and render a collapsed, focused view." This
> milestone tracks the Kerebron side: passing the focus and hosting the view.

## Out of scope

- FHIR / 837 resolvers (follow-ups once the resolver interface is proven)
- `.mdyt` template *authoring* in Kerebron (documents arrive pre-flattened)
- LSP diagnostics outside the editor (tracked separately)

## References

- MDY spec: https://github.com/mieweb/templit/blob/main/doc/mdy-specification.md
  (§4 editing semantics, §5 resolvers, §9 conformance)
- Samples: https://github.com/mieweb/templit/tree/main/samples
- eSheet field model: `packages/core/src/lib/types.ts` (`FieldDefinition`)
