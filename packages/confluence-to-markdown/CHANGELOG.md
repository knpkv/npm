# @knpkv/confluence-to-markdown

## 2.2.0

### Minor Changes

- [#366](https://github.com/knpkv/npm/pull/366) [`b08ca20`](https://github.com/knpkv/npm/commit/b08ca2004b3efcd72a695b44c72b56dae20afdfd) Thanks [@konopkov](https://github.com/konopkov)! - Add `confluence folder` and `confluence search`, so folders and content lookup no longer need the Confluence UI or a separate MCP client.

  `folder get`, `folder children` and `folder create` cover the container the page commands cannot address — `/pages/{id}` 404s on a folder id and vice versa. `folder get` and `folder children` accept either `--folder-id` or `--url`, and a folder URL pasted into either is read for its id, because the URL bar is the only place a folder id is actually visible: it appears in no page's front-matter. `folder children` follows pagination and reports each child's type, since a folder holds mixed content (pages, sub-folders, whiteboards, databases, embeds).

  `confluence search --cql "<query>"` runs a CQL query — the only way to find content by title or by parent, as there is no children-by-title endpoint. It sits at the top level rather than under `page` because CQL matches any content type.

  Request the OAuth scopes these endpoints need: `read:folder:confluence`, `write:folder:confluence`, `read:hierarchical-content:confluence` (direct children) and `read:content-details:confluence` (CQL search). They are requested on every `confluence auth login`, so add them to the OAuth app **before** logging in again — Atlassian rejects an authorization request naming a scope the app does not enable, which makes `auth login` itself fail at the authorize step. Existing tokens keep working for page and attachment commands until then; `folder` and `search` fail with 401/403 until the re-login lands. The scopes are kept in a separate `CONFLUENCE_FOLDER_SCOPES` constant so control-center, which shares `CONFLUENCE_SCOPES` for its own sign-in, keeps requesting only what it uses.

  Add `confluence auth manage`, which opens the Developer Console app list and prints the scopes to enable. It opens the list rather than the app itself because the console addresses an app by an id that is not the OAuth client id, and the client id is all this CLI stores. Both it and `auth create` derive the printed scopes from the constant `auth login` reads, so the setup instructions cannot drift from what login requests — the previous hardcoded list in `auth create` had already fallen behind the attachment scopes.

  `folder` and `search` refuse a site mismatch rather than acting on the wrong site. Content ids are per-site, so a `--base-url` disagreeing with the URL, a `--parent` pasted from another site, and — under OAuth — a `--base-url` that is not the active profile's site are all rejected. The OAuth case is the one that bites: those requests route by the profile's cloud id and ignore `--base-url` entirely, so `folder create --base-url site-a` while signed in to site B would otherwise create the folder on site B with no warning.

  Accept a folder's `createdAt` as epoch milliseconds. The v2 folder endpoints return a number there even though the upstream spec declares an ISO-8601 string and every other content type honours it — so before this, `folder get` and `folder create` failed to decode every real folder. The spec patch widens the generated schema to accept both shapes and the client normalizes to ISO-8601, so callers see one representation.

  Patch the Confluence v2 spec so `FolderSingle.position`/`parentId`/`parentType` and `ChildrenResponse.childPosition` generate as nullable rather than `never`. The generator turns the upstream `{"type": "integer", "nullable": true}` shape into `never`, so a folder or child payload carrying any of these fields failed the generated decode before the response reached the caller — the same fix already applied to `Page`, `PageBulk` and `ChildPage`.

- [#370](https://github.com/knpkv/npm/pull/370) [`27d2ca1`](https://github.com/knpkv/npm/commit/27d2ca18b0c0b0f8a252d461c0aaf10eb92e9ffc) Thanks [@konopkov](https://github.com/konopkov)! - Enforce the complete anti-slop rule set with zero accepted diagnostics and update affected APIs and implementations to satisfy the required contracts.

- [#354](https://github.com/knpkv/npm/pull/354) [`2e26e30`](https://github.com/knpkv/npm/commit/2e26e3032ce527260a4e4d9fca8af43039f762d6) Thanks [@konopkov](https://github.com/konopkov)! - Fix round-trip duplication of nested blocks, and add ADF-level page commands.

  `sync push` duplicated any block nested inside another encoded block — most
  visibly a Jira datasource card inside an expand. The reverter's scan for a
  closing marker stopped at the first _nested_ open marker, so the parent never
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
    good. Note that _any_ push error holds the branch, not only a refusal, so
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

### Patch Changes

- [#358](https://github.com/knpkv/npm/pull/358) [`503d345`](https://github.com/knpkv/npm/commit/503d3459b419a3c9fd366715d5916e41086f493d) Thanks [@konopkov](https://github.com/konopkov)! - Apply the same OAuth rotation hardening as `@knpkv/jira-cli` to
  `ConfluenceAuth`, which is built on the same shared `refreshToken` and carried
  both halves of the defect.

  `refreshTokenImpl` did an interruptible rotate-then-persist with no deadline.
  Atlassian rotates refresh tokens, so an interrupt between the grant and the save
  spends the credential without storing its replacement and silently logs the user
  out; an unbounded stall hung the command indefinitely. Grant and persist are now
  one `Effect.uninterruptible` region with its own 30s deadline inside it — inside,
  because an uninterruptible region with no bound of its own also absorbs
  SIGINT/SIGTERM and would leave `confluence` ignoring Ctrl-C.

  `getAccessToken` also deleted the stored token on any `step: "refresh"` failure,
  so a timeout, a transport error, a `429`, or a `400 invalid_client` from a
  rotated client secret all logged the user out unrecoverably. It now deletes only
  on `400 invalid_grant` or a `403` revocation, using `OAuthError.status` and
  `OAuthError.errorCode` from `@knpkv/atlassian-common`.

- [#361](https://github.com/knpkv/npm/pull/361) [`676419e`](https://github.com/knpkv/npm/commit/676419e39c395dd4cfea6d9ffaee7d002a3f75e2) Thanks [@konopkov](https://github.com/konopkov)! - Update Effect and effect-qb, migrate schema-tagged errors to the current Effect API, and adopt the dialect-scoped SQLite function and type APIs introduced by effect-qb 0.22.

- [#357](https://github.com/knpkv/npm/pull/357) [`77e3257`](https://github.com/knpkv/npm/commit/77e3257743aacfaf9e11e016a60206f416c5fe79) Thanks [@konopkov](https://github.com/konopkov)! - Secure local control planes and CI credential boundaries. CodeCommit web now
  uses a process-scoped owner session with CSRF protection and loopback-only
  listeners; review sandboxes use authenticated loopback code-server instances,
  digest-pinned images, constrained mounts, non-root execution, and dropped
  capabilities. OAuth callback listeners validate state before accepting terminal
  outcomes and bind explicitly to loopback. GitHub workflows pin external actions
  to immutable commits and keep long-lived Atlassian credentials out of pull
  request execution.
- Updated dependencies [[`503d345`](https://github.com/knpkv/npm/commit/503d3459b419a3c9fd366715d5916e41086f493d), [`b08ca20`](https://github.com/knpkv/npm/commit/b08ca2004b3efcd72a695b44c72b56dae20afdfd), [`676419e`](https://github.com/knpkv/npm/commit/676419e39c395dd4cfea6d9ffaee7d002a3f75e2), [`b08ca20`](https://github.com/knpkv/npm/commit/b08ca2004b3efcd72a695b44c72b56dae20afdfd), [`27d2ca1`](https://github.com/knpkv/npm/commit/27d2ca18b0c0b0f8a252d461c0aaf10eb92e9ffc)]:
  - @knpkv/atlassian-common@1.4.0
  - @knpkv/confluence-api-client@1.1.0
  - @knpkv/agent-skills@0.3.0

## 2.1.3

### Patch Changes

- [#343](https://github.com/knpkv/npm/pull/343) [`4def7db`](https://github.com/knpkv/npm/commit/4def7db2f400cf68218262994d67ed90a7154bf1) Thanks [@konopkov](https://github.com/konopkov)! - Align runtime ownership, cancellation, caching, time, failure handling, polling,
  decoding, and executable entrypoints with Effect v4 idioms. Expose clock-injected
  Atlassian token construction and expiry helpers, and enable workspace-wide
  Effect diagnostics and prevention checks.
- Updated dependencies [[`4def7db`](https://github.com/knpkv/npm/commit/4def7db2f400cf68218262994d67ed90a7154bf1), [`a9d5408`](https://github.com/knpkv/npm/commit/a9d54085f6fc25cde1d5b298f50cb6e06e2bc93f)]:
  - @knpkv/atlassian-common@1.3.0

## 2.1.2

### Patch Changes

- [#251](https://github.com/knpkv/npm/pull/251) [`bf74411`](https://github.com/knpkv/npm/commit/bf744117e07b84b28e139ee131687fd36d080e3e) Thanks [@konopkov](https://github.com/konopkov)! - Patch two high-severity transitive dependency advisories via `pnpm-workspace.yaml`
  overrides:

  - **fast-uri** — bump `<=3.1.3` to `^3.1.4` (GHSA-v2hh-gcrm-f6hx: host confusion
    via literal backslash authority delimiter). Pulled in through `ajv`; affects
    `@knpkv/confluence-to-markdown` and `@knpkv/rly`.
  - **fast-xml-parser** — bump the `@distilled.cloud/aws` override from `^5.3.4` to
    `^5.10.1` (GHSA-8r6m-32jq-jx6q: repeated DOCTYPE declarations reset entity
    expansion limits). Affects `@knpkv/codecommit-core` and `@knpkv/control-center`.

  No source changes; `pnpm audit --prod && pnpm audit --dev` now reports no known
  vulnerabilities.

## 2.1.1

### Patch Changes

- [#125](https://github.com/knpkv/npm/pull/125) [`f820c19`](https://github.com/knpkv/npm/commit/f820c1906e00f2f2d17c2e7cc3921ba26522db43) Thanks [@konopkov](https://github.com/konopkov)! - Replace the legacy Atlassian `openapi-fetch` clients with generated,
  Schema-validated Effect clients. Jira and Confluence now provide direct Effect
  operations, injected `HttpClient` transports, deterministic local regeneration,
  structural upstream freshness checks, and scheduled tested update pull requests.

  The legacy `toEffect`, `FetchClientError`, raw `.client` operation surface, and
  type-only generated subpaths are removed.

- [#125](https://github.com/knpkv/npm/pull/125) [`f820c19`](https://github.com/knpkv/npm/commit/f820c1906e00f2f2d17c2e7cc3921ba26522db43) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade the workspace to Effect 4.0.0-beta.98 and current compatible dependencies. Replace ad hoc object guards with Effect Predicate helpers and migrate retry schedules to the current Schedule API.

- [#122](https://github.com/knpkv/npm/pull/122) [`331e503`](https://github.com/knpkv/npm/commit/331e503f66c249276967a78040fa504d708e0244) Thanks [@konopkov](https://github.com/konopkov)! - Honor Markdown table cell edits on push by merging GFM content over sidecar attrs. Rows and columns are aligned by plain-text fingerprint: cell edits merge freely when the shape is unchanged, a single row/column insert or delete merges anywhere in the table, pure reorders keep attrs travelling with the moved content, and edits combined with a tail append are both honored. Header-column identity is restored on rows inserted via GFM, headerless tables keep their synthetic empty GFM header row out of the alignment, and lossy cells (multi-block bodies, hardBreaks, boundary whitespace) keep the authoritative sidecar body instead of adopting the degraded GFM copy — structural changes to tables containing such cells fall back entirely, since those cells can never fingerprint-match their GFM copies. Fingerprints include marks (`foo` vs `**foo**`) and attr-carried content (status lozenges, dates, emoji) so moved formatted or leaf-only cells are recognised, and column identity is judged on the rows both tables share so a column swap combined with a row append merges correctly. Ambiguous shapes fall back to the sidecar node instead of guessing: duplicate-text rows/columns around a structural change (including a duplicate moving past an anchored twin), reorders mixed with edits, rows and columns reordered or resized in the same push, ragged (non-rectangular) tables, and merged-cell tables.

- Updated dependencies [[`f820c19`](https://github.com/knpkv/npm/commit/f820c1906e00f2f2d17c2e7cc3921ba26522db43), [`665cecb`](https://github.com/knpkv/npm/commit/665cecbc3d5f79f9083acb1b393ace9a8ec0b1b8), [`f820c19`](https://github.com/knpkv/npm/commit/f820c1906e00f2f2d17c2e7cc3921ba26522db43), [`1bba5c2`](https://github.com/knpkv/npm/commit/1bba5c282684553fbc670e6dcf2960e8a4e200ed)]:
  - @knpkv/confluence-api-client@1.0.0
  - @knpkv/atlassian-common@1.2.0
  - @knpkv/agent-skills@0.2.3

## 2.1.0

### Minor Changes

- [#114](https://github.com/knpkv/npm/pull/114) [`904d3d7`](https://github.com/knpkv/npm/commit/904d3d75948d94558484094cf225b5ea6585663e) Thanks [@konopkov](https://github.com/konopkov)! - Add Jira and Confluence attachment support.

  - Add shared attachment rendering and placeholder replacement helpers.
  - Support multipart attachment upload calls in Jira and Confluence API clients.
  - Render Jira attachments as inline image previews or links with hidden attachment metadata.
  - Resolve Confluence media attachments to visible Markdown previews while preserving native media ADF identity.
  - Add explicit Jira and Confluence attachment upload commands with optional Markdown placeholder insertion.

### Patch Changes

- Updated dependencies [[`904d3d7`](https://github.com/knpkv/npm/commit/904d3d75948d94558484094cf225b5ea6585663e)]:
  - @knpkv/atlassian-common@1.1.0
  - @knpkv/confluence-api-client@0.4.0

## 2.0.0

### Major Changes

- Stop importing legacy Confluence OAuth tokens from `~/.confluence/auth.json`.

  Existing users with only the legacy token file must run `confluence auth login` again so credentials are stored as shared Atlassian auth profiles under `~/.config/atlassian/confluence-to-markdown/`. Legacy `~/.confluence/config.json` OAuth client configuration is still migrated.

### Patch Changes

- Updated dependencies [[`734f891`](https://github.com/knpkv/npm/commit/734f8911d930cedc8642d5e2bd9fa73c76a99054)]:
  - @knpkv/atlassian-common@1.0.0

## 1.1.0

### Minor Changes

- [#103](https://github.com/knpkv/npm/pull/103) [`477e4c6`](https://github.com/knpkv/npm/commit/477e4c60fa5c501883be6c03629da5a3cc91444c) Thanks [@konopkov](https://github.com/konopkov)! - Add shared Atlassian auth profile storage for multi-account and multi-site OAuth use.

  Jira and Confluence now expose `auth profiles`, `auth use <profile>`, and `auth remove <profile>` commands backed by shared profile management in `@knpkv/atlassian-common`. Confluence also migrates existing legacy auth/config files on first use. Agent skills and docs now describe the profile commands and active-profile checks.

### Patch Changes

- [#105](https://github.com/knpkv/npm/pull/105) [`a3a4d3a`](https://github.com/knpkv/npm/commit/a3a4d3a14fafe235bc901ed5015bb9bd82c59281) Thanks [@konopkov](https://github.com/konopkov)! - Add a unified Atlassian profile manager CLI with cross-tool profile listing, selection, diagnostics, token refresh, and scope validation helpers.

  Update bundled Jira, Confluence, and Jira Clockify agent skills to recommend the unified profile diagnostics workflow.

- Updated dependencies [[`477e4c6`](https://github.com/knpkv/npm/commit/477e4c60fa5c501883be6c03629da5a3cc91444c), [`a3a4d3a`](https://github.com/knpkv/npm/commit/a3a4d3a14fafe235bc901ed5015bb9bd82c59281)]:
  - @knpkv/atlassian-common@0.4.0
  - @knpkv/agent-skills@0.2.2

## 1.0.0

### Major Changes

- [#99](https://github.com/knpkv/npm/pull/99) [`59478b0`](https://github.com/knpkv/npm/commit/59478b0d059d359feaf38222e5e55f748ee389d7) Thanks [@konopkov](https://github.com/konopkov)! - Refactor CLI command surfaces around resource-first groups and remove the legacy top-level aliases.

  - Jira issue reads now live under `jira issue get` and `jira issue search`; version reads and writes use `jira version get`, `jira version update`, and `jira version related-work`.
  - Confluence workspace setup now uses `confluence workspace clone`, page operations use `confluence page`, and sync/git-backed operations use `confluence sync`.
  - JCF timer operations now use `jcf timer`, ticket listing uses `jcf issue list`, and reconciliation uses `jcf sync reconcile`.
  - Agent skills and product-local skill copies now document the same canonical commands.

### Patch Changes

- [#91](https://github.com/knpkv/npm/pull/91) [`b1cb35f`](https://github.com/knpkv/npm/commit/b1cb35f4469bcf224978a3a724ea4c782a3db883) Thanks [@konopkov](https://github.com/konopkov)! - Preserve Confluence code block metadata, including custom width breakout marks, through markdown round-trips.

- Updated dependencies [[`59478b0`](https://github.com/knpkv/npm/commit/59478b0d059d359feaf38222e5e55f748ee389d7)]:
  - @knpkv/agent-skills@0.2.1

## 0.7.0

### Minor Changes

- [#81](https://github.com/knpkv/npm/pull/81) [`19c1538`](https://github.com/knpkv/npm/commit/19c153835bc198b9e407a013c16775c3fb7eb357) Thanks [@konopkov](https://github.com/konopkov)! - Ship agent skills alongside each CLI package and add an installer package plus per-CLI `skills install` commands for Codex and Claude.

- [#85](https://github.com/knpkv/npm/pull/85) [`f01d83a`](https://github.com/knpkv/npm/commit/f01d83a091a13808b36aadfd45989240da537e8f) Thanks [@konopkov](https://github.com/konopkov)! - Add `confluence fetch` for printing the latest page markdown without creating a git workspace, support `--url` page parsing for `fetch` and `clone`, and add opt-in `--clean-markdown` output that strips Confluence round-trip metadata comments.

- [#71](https://github.com/knpkv/npm/pull/71) [`e3c3805`](https://github.com/knpkv/npm/commit/e3c3805ee527a6edb69ed91977c95c586b563ff9) Thanks [@konopkov](https://github.com/konopkov)! - Migrate the package workspace to Effect v4 beta.

  This updates runtime and peer dependencies to the Effect v4 beta module layout,
  adopts Effect platform/runtime services for Node process, HTTP, filesystem, and
  clock access, and refreshes package export metadata to point published type
  entries at emitted `dist/*.d.ts` declarations.

  CodeCommit packages now use Effect v4-compatible AWS and cache layers, including
  typed `distilled-aws` context services, shared cached-comment decoding, and
  schema-derived config defaults. Jira and Confluence OAuth callback servers bind
  the expected local callback port range again under the Effect v4 Node HTTP
  server layer.

  The retired Claude AI packages have been removed from the workspace.

### Patch Changes

- [#72](https://github.com/knpkv/npm/pull/72) [`0e1c5ea`](https://github.com/knpkv/npm/commit/0e1c5eaf6d48c43e6591b6b6260dbfbf6bfb810b) Thanks [@konopkov](https://github.com/konopkov)! - Preserve Confluence-native ADF elements through markdown sync by storing decoded
  placeholder metadata in per-page `.adf.json` sidecars and hydrating those refs
  before push.

  The integration test now requires API auth for raw ADF verification, asserts the
  sidecar file contract, and checks native node and mark metadata across the
  create/update/reclone cycle.

- [#78](https://github.com/knpkv/npm/pull/78) [`b833841`](https://github.com/knpkv/npm/commit/b8338412b2352188a8505e4ee46ccd3f86a6b58f) Thanks [@konopkov](https://github.com/konopkov)! - Externalize base64-encoded ADF placeholder metadata into `.adf.json` sidecars
  when pulling Confluence macros and native nodes.
- Updated dependencies [[`c697d3c`](https://github.com/knpkv/npm/commit/c697d3c4ab779f14f017d3ec8fc8d1bffa1493b5), [`19c1538`](https://github.com/knpkv/npm/commit/19c153835bc198b9e407a013c16775c3fb7eb357), [`e3c3805`](https://github.com/knpkv/npm/commit/e3c3805ee527a6edb69ed91977c95c586b563ff9)]:
  - @knpkv/agent-skills@0.2.0
  - @knpkv/confluence-api-client@0.3.0

## 0.6.0

### Minor Changes

- [#67](https://github.com/knpkv/npm/pull/67) [`10a1cc0`](https://github.com/knpkv/npm/commit/10a1cc068e907b4d2fb7e176cc834a0c8cddef3b) Thanks @konopkov! - Switch wire format from Confluence storage format to Atlassian Document
  Format (ADF). Push (markdown → ADF) is now handled by the official
  `@atlaskit/editor-markdown-transformer` + `@atlaskit/editor-json-transformer`;
  pull (ADF → markdown) by an in-package tree walker typed against
  `@atlaskit/adf-schema`. The bespoke storage-format parsers and serializers
  (~140 KB) are removed. CLI behavior is unchanged. When `saveSource` is
  enabled, the `.source` companion file is now `<page>.source.json` instead of
  `<page>.html`; existing companion `.html` files are harmless and can be
  deleted.

  Confluence macros now survive a pull → edit → push round-trip: extension
  placeholders carry the macro's full attrs (parameters, layout, localId) as a
  base64 blob, and a bodied macro's body is re-attached from the blocks between
  its `<!-- adf:bodiedExtension … -->` / `<!-- adf:/bodiedExtension -->`
  markers. Constructs that still degrade on push (panels, task lists, dates,
  emojis, expand sections, inline cards, media captions) are documented under
  "Known fidelity limitations" in the README.

## 0.5.0

### Minor Changes

- [#65](https://github.com/knpkv/npm/pull/65) [`c5ba754`](https://github.com/knpkv/npm/commit/c5ba75417471740f133565e8174bc5849b724125) Thanks @konopkov! - Improve markdown rendering and round-trip fidelity for Confluence pages:
  - Preserve nested lists across the round-trip — second-level bullets now become proper indented markdown lists instead of raw HTML with leftover `local-id` attributes.
  - Unwrap table cells with a leading empty `<p>` placeholder so styled cells (e.g. `<td><p/><p><strong>Must</strong></p></td>`) collapse to their real content.
  - Emit a synthetic markdown header divider (`| --- | --- |`) for tables that have no `<thead>`, so they render as tables in markdown viewers; the synthetic header is dropped on parse so the round-trip back to Confluence stays bit-exact.
  - Render `expand` macros as GFM `<details><summary>` blocks; body content is now visible (and collapsible) in markdown viewers and round-trips back to a Confluence `expand` macro.
  - Render inline `UserMention`, `StatusMacro`, and `TocMacro` as visible markdown links (`[@id](#cf-user:id)`, `[STATUS](#cf-status:Color)`, `[Table of Contents](#cf-toc:min:max)`) instead of opaque HTML comments; the parser recognises the `#cf-…` URL fragments and rebuilds the original AST nodes for round-trip.
  - Add support for the `view-file` Confluence macro: attached files now render as `[filename](attachment:filename)` markdown links and round-trip back to `<ac:structured-macro ac:name="view-file">`.
  - Fix an infinite loop in the structured-macro preprocessor: unsupported macros (e.g. `anchor`) were preserved verbatim inside a wrapping `<div>`, which caused `processStructuredMacros` to re-match the same `<ac:structured-macro>` tag forever and silently drop everything that came after it (including, for affected pages, the `view-file` macro).

## 0.4.2

### Patch Changes

- [#61](https://github.com/knpkv/npm/pull/61) [`fc7be8f`](https://github.com/knpkv/npm/commit/fc7be8ffaf5b6b094c7f81551e8ace6f2a8f2c4c) Thanks @konopkov! - feat: add jira-api-client and atlassian-common packages
  - New @knpkv/atlassian-common: shared AST types, serializers, auth, and config
  - New @knpkv/jira-api-client: Effect-based Jira REST API client (openapi-gen)
  - Updated @knpkv/confluence-api-client: regenerated with openapi-gen
  - Updated @knpkv/confluence-to-markdown: use new generated API client

- Updated dependencies [[`fc7be8f`](https://github.com/knpkv/npm/commit/fc7be8ffaf5b6b094c7f81551e8ace6f2a8f2c4c)]:
  - @knpkv/confluence-api-client@0.2.1

## 0.4.1

### Patch Changes

- [#23](https://github.com/knpkv/npm/pull/23) [`bd5bbf4`](https://github.com/knpkv/npm/commit/bd5bbf4679ae1d41b33182fcca70adf0960f0839) Thanks @konopkov! - feat(confluence-api-client): new package for Confluence Cloud REST API

  New `@knpkv/confluence-api-client` package with Effect-based Confluence Cloud REST API client:
  - V1 API: `/user`, `/content/{id}/property/{key}` endpoints
  - V2 API: Pages CRUD with pagination support
  - Basic auth (email + API token) and OAuth2 (access token + cloud ID)
  - Effect Layer wrapper with config service
  - Daily CI workflow for spec updates

  Migrated `confluence-to-markdown` to use new API client package.

- [#24](https://github.com/knpkv/npm/pull/24) [`cbbe42f`](https://github.com/knpkv/npm/commit/cbbe42f8747af8955aacfa64a7e3868035cffec5) Thanks @konopkov! - Fix Confluence link handling and consolidate preprocessing modules
  - Handle `<ac:link><ac:link-body>` pattern that was being lost during conversion
  - Consolidate duplicate preprocessing code (deleted `parsers/preprocessing/`)
  - Remove type assertion casts in favor of Schema.decodeSync
  - Fix CI: configure git user.name/email in init for fresh repos

- Updated dependencies [[`bd5bbf4`](https://github.com/knpkv/npm/commit/bd5bbf4679ae1d41b33182fcca70adf0960f0839)]:
  - @knpkv/confluence-api-client@0.2.0

## 0.4.0

### Minor Changes

- [#21](https://github.com/knpkv/npm/pull/21) [`f696d00`](https://github.com/knpkv/npm/commit/f696d0056de28f2871a48a0caac88b696c86ba68) Thanks @konopkov! - Add git version tracking and CLI improvements
  - Add GitService for git operations with version history replay
  - Add clone command that pulls pages with full version history
  - Flatten git commands: confluence commit/log/diff (was: confluence git ...)
  - Add auth status subcommand
  - Reorganize bin.ts into separate command files
  - Add nice error messages without stack traces
  - Clone fails if already cloned

## 0.3.0

### Minor Changes

- [#19](https://github.com/knpkv/npm/pull/19) [`15b1ff7`](https://github.com/knpkv/npm/commit/15b1ff70e9e7a406ddbc4ce8bcd0673965464421) Thanks @konopkov! - Add OAuth authentication for Confluence Cloud
  - `confluence auth create` - opens Atlassian Developer Console to create OAuth app
  - `confluence auth configure` - save client ID/secret
  - `confluence auth login` - browser-based OAuth flow
  - `confluence auth logout` - remove stored token
  - Show login status in `confluence status`
  - Auto-refresh tokens when expired
  - Use granular scopes for API v2: read:page:confluence, write:page:confluence

## 0.2.1

### Patch Changes

- [#17](https://github.com/knpkv/npm/pull/17) [`879af56`](https://github.com/knpkv/npm/commit/879af56383230d852e1434efb67e6f5cdffd3507) Thanks @konopkov! - Improve type safety and code organization:
  - Add MdastRootSchema with runtime validation
  - Extract preprocessing to separate module
  - Consolidate duplicate mdastToString utility
  - Use exhaustive switch statements

## 0.2.0

### Minor Changes

- [#14](https://github.com/knpkv/npm/pull/14) [`ddb73a3`](https://github.com/knpkv/npm/commit/ddb73a3b2633ec2e531ba2ff3f3a3b55fbadef3a) Thanks @konopkov! - Initial release of confluence-to-markdown package
  - CLI with init/pull/push/sync/status commands
  - Effect-TS based Confluence REST API v2 client
  - Bidirectional markdown sync with frontmatter
  - HTML to GFM conversion via rehype/remark
  - Interactive prompts for missing CLI args
