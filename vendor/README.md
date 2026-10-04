# Temporary upstream checkouts

These seven Git submodules provide source references and integration workspaces
while edEditIt develops complete MDY and MDYT support. Each checkout is pinned to
the commit recorded by the parent repository, so the reference set is reproducible.

| Checkout | Upstream | Role | Pinned commit |
|---|---|---|---|
| `kerebron` | [mieweb/kerebron](https://github.com/mieweb/kerebron) | Editor, document conversion, and extension integration | `fa8d4ee` |
| `templit` | [mieweb/templit](https://github.com/mieweb/templit) | MDY specification, MDYT samples, and implicit field-link rendering | `7927953` |
| `esheet` | [mieweb/eSheet](https://github.com/mieweb/eSheet) | Form definitions, responses, and field editor components | `13799ca` |
| `lsp-toy` | [horner/lsp-toy](https://github.com/horner/lsp-toy) | VS Code language-server reference implementation | `f31e940` |
| `osheet` | [mieweb/osheet](https://github.com/mieweb/osheet) | Legacy clinical forms and migration reference | `ce21fb7` |
| `yabelfish` | [mieweb/yabelfish](https://github.com/mieweb/yabelfish) | Clinical language-server and structured-data integration | `5810dba` |
| `hey-ozwell` | [mieweb/hey-ozwell](https://github.com/mieweb/hey-ozwell) | Wake-word and voice-entry integration | `2ff10d1` |

The extension currently builds from published npm dependencies, including
`@kerebron/*`. Restoring these checkouts does not change package resolution or
wire their source into the runtime. Any local-source integration must be added
explicitly and reviewed with its dependency and build changes.

## Initialize the checkouts

For a fresh clone:

```sh
git clone --recurse-submodules https://github.com/mieweb/edEditIt.git
cd edEditIt
```

For an existing clone, run from the repository root:

```sh
git submodule update --init --recursive
```

The repository's bootstrap script also initializes the submodules and pulls
hey-ozwell model assets when Git LFS is installed:

```sh
./scripts/bootstrap.sh
```

These commands use the recorded commits. Do not add `--remote` or automatically
advance the checkouts to upstream branch tips; commit changes should be selected,
tested, and recorded deliberately in the parent repository.

## Retire this temporary arrangement

Keep the checkouts until the integration supports:

- MDYT rendering into complete MDY documents, including merged YAML front matter,
  template provenance, and a flattened Markdown body with field links.
- Protected field spans and resolver editing that updates canonical data and all
  linked displays, with eSheet support.
- YAML and Markdown preserving round trips: byte-identical no-op saves and
  minimal diffs for field edits, retaining comments and formatting.

These are completion criteria, not claims of existing support. Once the required
upstream changes are published and the extension consumes those packages, remove
the temporary checkouts and their submodule entries. Keep durable documentation
and fixtures in edEditIt or their authoritative upstream projects.
