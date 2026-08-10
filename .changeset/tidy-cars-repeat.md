---
"@knpkv/confluence-to-markdown": minor
---

Fix round-trip duplication of nested blocks, and add ADF-level page commands.

`sync push` duplicated any block nested inside another encoded block — most
visibly a Jira datasource card inside an expand. The reverter's scan for a
closing marker stopped at the first *nested* open marker, so the parent never
paired: it was restored from its payload and the inner marker was reverted
again as a sibling. One extra copy per push, compounding silently.

- Pair encoded block markers by depth, so nested blocks round-trip. Covered by
  a new ADF → markdown → ADF fixpoint suite that asserts the structural node
  census is unchanged across repeated cycles.
- `sync push` now refuses a page whose remote ADF holds nodes markdown cannot
  represent and points at the ADF commands; `--force` overrides. Other
  structural drift is logged rather than blocked. The unsafe set is narrow: a
  `blockCard`/`embedCard` with no resolvable url, a `multiBodiedExtension`, and
  a bodied macro inside a table cell. Datasource cards, ordinary macros such as
  TOC and excerpt, and anything nested inside a table all round-trip via their
  markers and stay pushable. A refused push no longer advances
  `origin/confluence`, so the retry — with or without `--force` — still has
  something to push, and a deletion already applied in Confluence is replayed
  harmlessly rather than counted as a failure that would park the branch for
  good. Note that *any* push error holds the branch, not only a refusal, so
  unsent work is never recorded as pushed — the failure then repeats on every
  push until it is resolved, and the command now says so. `--force` covers the
  round-trip refusal only, and applies to the whole run rather than one page.
- `page put --if-version <n>` opts into the optimistic-version check `page
  patch` always makes, so the read-modify-write the refusal message recommends
  cannot silently overwrite an edit made in Confluence in between. `page get
  --format adf` reports that version on stderr, leaving stdout the
  machine-readable document.
- `sync push --dry-run` now runs the round-trip guard, so a preview reports the
  refusal that the real push would raise instead of a clean plan. It also counts
  pending deletions and reports a new page as created, so a workspace whose only
  change is a deleted page no longer previews as "Nothing to push" immediately
  before the real run deletes it remotely.
- `page create` sets the v2 editor property, as the workspace create path
  already did; without it an ADF-bodied page can open in the legacy editor.
- `page patch --dry-run` validates the patched document, so a preview no longer
  passes where the real write fails.
- A `roundTrip: unsafe` flag is recomputed after a push instead of inherited, so
  a `--force` push that flattened the unsafe nodes stops warning about them.
- Pages holding such nodes are marked `roundTrip: unsafe` in front-matter on
  pull, so the warning is visible before editing.
- New `confluence page get --format adf`, `page put --adf`, `page create --adf`
  and `page patch` (`--replace/--with`, `--delete-node`, `--dry-run`) — edit or
  create a page without the markdown projection. `page put`/`page create`
  support `{{slot}}` substitution via `--set name=value`. `page patch` writes
  the version it read, so a concurrent edit surfaces as a conflict rather than
  being overwritten, and `page create --base-url` is checked against the same
  host allowlist as every other entry point.
- `--base-url` accepts the `/wiki` form users copy from the browser, and is
  inferred from a surrounding workspace when omitted.
- The OAuth token-refresh notice goes to stderr, so `--format adf` output is
  machine-readable.
