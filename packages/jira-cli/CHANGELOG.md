# @knpkv/jira-cli

## 1.3.0

### Minor Changes

- [#366](https://github.com/knpkv/npm/pull/366) [`b08ca20`](https://github.com/knpkv/npm/commit/b08ca2004b3efcd72a695b44c72b56dae20afdfd) Thanks [@konopkov](https://github.com/konopkov)! - Add `jira version create` and `jira issue edit`, closing the two gaps that forced release scaffolding out of the CLI.

  `jira version create --project <KEY> --name <NAME>` opens a new unreleased version, optionally with `--description`, `--start-date` and `--release-date`. The project key is resolved to the numeric `projectId` the endpoint requires, and dates are validated as ISO 8601 locally so a bad one names its own flag instead of returning an unattributed 400.

  `jira issue edit <KEY>` edits fix versions and labels. Both fields are sets, so the incremental flags — `--add-fix-version`, `--remove-fix-version`, `--add-label`, `--remove-label` — are the ones to reach for: they go through Jira's `update` verb, which applies server-side and cannot clobber a concurrent edit. The replacing forms (`--fix-version`, `--label`) are still available and say in their help that they drop anything not listed. Passing both forms for one field is refused up front, because Jira's own error for that case does not name the offending field.

- [#354](https://github.com/knpkv/npm/pull/354) [`2e26e30`](https://github.com/knpkv/npm/commit/2e26e3032ce527260a4e4d9fca8af43039f762d6) Thanks [@konopkov](https://github.com/konopkov)! - Add `jira version related-work sync` — reconcile a version's related-work links
  against the given set instead of blindly appending.

  Repeated `related-work add` calls pile up duplicate "Release notes" links every
  time a release is re-scaffolded. `sync` takes the desired set as repeatable
  `--link title=url` flags and adds only what is missing, matching on URL (the
  only stable identity a link has — Jira assigns the id and the title is
  editable, so a link retitled by hand is still recognised). Scoped to one
  `--category` so reconciling `Communication` cannot disturb `Testing` links.
  `--prune` opts into removing extras, which is off by default because links
  added by hand in the Jira UI are legitimate; it removes surplus copies of a
  desired URL too, since an existing pile-up is the case it exists to clean up.
  Repeated `--link` flags for one URL collapse to a single link.

  The planning step is exposed as the pure `planRelatedWorkSync` and covered by
  tests, including that a second run is a no-op.

- [#370](https://github.com/knpkv/npm/pull/370) [`27d2ca1`](https://github.com/knpkv/npm/commit/27d2ca18b0c0b0f8a252d461c0aaf10eb92e9ffc) Thanks [@konopkov](https://github.com/konopkov)! - Enforce the complete anti-slop rule set with zero accepted diagnostics and update affected APIs and implementations to satisfy the required contracts.

### Patch Changes

- [#358](https://github.com/knpkv/npm/pull/358) [`503d345`](https://github.com/knpkv/npm/commit/503d3459b419a3c9fd366715d5916e41086f493d) Thanks [@konopkov](https://github.com/konopkov)! - Make the OAuth refresh-token rotation atomic so an interrupted CLI cannot log
  the user out.

  Atlassian rotates refresh tokens: the refresh response carries a replacement and
  the token that was sent is consumed server-side. `refreshTokenImpl` performed
  the grant and then persisted the result in a separate, interruptible step, so a
  fiber interrupt landing between the two destroyed the credential — the stored
  refresh token was already spent, the replacement was never written, and the next
  refresh failed with a 4xx. `getAccessToken` treats that failure as an expired
  refresh token and deletes the token file, so the user was silently logged out
  and had to run `jira auth login` again.

  Nothing interrupted it before, which is why this had not surfaced. It becomes
  reachable as soon as a caller kills the process: this runs during layer
  construction on every CLI invocation, and `@knpkv/jira-clockify`'s nvim
  statusline terminates the poll process when the editor closes. The grant and
  the persist now share one `Effect.uninterruptible` region.

  That region carries its own 30s deadline rather than relying on a caller's, for
  two reasons. A caller's `Effect.timeout` would be inert — `timeout` is a race,
  and racing an uninterruptible loser means waiting for it anyway. And an
  uninterruptible region with no deadline of its own absorbs SIGINT/SIGTERM
  entirely, since `NodeRuntime.runMain`'s signal handlers do nothing but interrupt
  the main fiber — a hung `jira` command would stop responding to Ctrl-C. The
  deadline forked inside the region is itself interruptible, so it does bound it.

  Abandoning the round-trip still cannot prove the grant did not land — Atlassian
  may consume and rotate the token after we stop listening, and no client-side
  deadline changes that. So the deadline is paired with a second rule:
  `getAccessToken` no longer deletes the stored token on any `step: "refresh"`
  failure. It deletes only on the answers that actually mean the grant is dead —
  the provider explicitly reporting `invalid_grant`, on a `400` or a `403` — using
  the new `OAuthError.status` and `OAuthError.errorCode` from
  `@knpkv/atlassian-common`. Previously a transport error or timeout deleted
  the active profile outright, which turned a bad network window into an
  unattended silent logout: `JiraApiConfigLive` builds on every CLI invocation,
  and jcf's statusline runs one every 30 seconds.

  The statuses deliberately left alone matter as much. `429` is the one this most
  needs to survive — several `jira`/`jcf` processes on one expired token hit the
  endpoint together, one wins the rotation and the rest are rate-limited. `408`
  and `425` restate the timeout case. `407` and other middlebox replies never came
  from Atlassian at all. `401` and `400 invalid_client` mean the client secret is
  wrong, where the fix is `jira auth configure`, not a re-login that would fail
  the same way. A bare `403` is left alone too: it is as likely to be a proxy or
  WAF as Atlassian revoking anything. An unparseable body is no verdict at all.

  Now an incomplete refresh normally costs a retry rather than the session. This
  narrows the window rather than closing it: the atomicity is fiber-level, so a
  SIGKILL after Atlassian has already rotated the token still loses the
  replacement, and the next refresh then legitimately reports `invalid_grant`. No
  client-side design can close that window against a hard kill.

  Covered by tests: a refresh that never answers and one that is rate-limited both
  leave the profile on disk, a `400` removes it, and an interrupt mid-rotation
  still persists the replacement token.

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
  - @knpkv/agent-skills@0.3.0
  - @knpkv/jira-api-client@1.1.0

## 1.2.3

### Patch Changes

- [#343](https://github.com/knpkv/npm/pull/343) [`4def7db`](https://github.com/knpkv/npm/commit/4def7db2f400cf68218262994d67ed90a7154bf1) Thanks [@konopkov](https://github.com/konopkov)! - Align runtime ownership, cancellation, caching, time, failure handling, polling,
  decoding, and executable entrypoints with Effect v4 idioms. Expose clock-injected
  Atlassian token construction and expiry helpers, and enable workspace-wide
  Effect diagnostics and prevention checks.
- Updated dependencies [[`4def7db`](https://github.com/knpkv/npm/commit/4def7db2f400cf68218262994d67ed90a7154bf1), [`a9d5408`](https://github.com/knpkv/npm/commit/a9d54085f6fc25cde1d5b298f50cb6e06e2bc93f)]:
  - @knpkv/atlassian-common@1.3.0

## 1.2.2

### Patch Changes

- [#252](https://github.com/knpkv/npm/pull/252) [`6d510c9`](https://github.com/knpkv/npm/commit/6d510c9d3dab3e459db7fa1d25cd12f0e122699e) Thanks [@konopkov](https://github.com/konopkov)! - Update the generated Schema-backed Jira API client.

- Updated dependencies [[`6d510c9`](https://github.com/knpkv/npm/commit/6d510c9d3dab3e459db7fa1d25cd12f0e122699e)]:
  - @knpkv/jira-api-client@1.0.1

## 1.2.1

### Patch Changes

- [#125](https://github.com/knpkv/npm/pull/125) [`f820c19`](https://github.com/knpkv/npm/commit/f820c1906e00f2f2d17c2e7cc3921ba26522db43) Thanks [@konopkov](https://github.com/konopkov)! - Replace the legacy Atlassian `openapi-fetch` clients with generated,
  Schema-validated Effect clients. Jira and Confluence now provide direct Effect
  operations, injected `HttpClient` transports, deterministic local regeneration,
  structural upstream freshness checks, and scheduled tested update pull requests.

  The legacy `toEffect`, `FetchClientError`, raw `.client` operation surface, and
  type-only generated subpaths are removed.

- [#125](https://github.com/knpkv/npm/pull/125) [`f820c19`](https://github.com/knpkv/npm/commit/f820c1906e00f2f2d17c2e7cc3921ba26522db43) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade the workspace to Effect 4.0.0-beta.98 and current compatible dependencies. Replace ad hoc object guards with Effect Predicate helpers and migrate retry schedules to the current Schedule API.

- Updated dependencies [[`f820c19`](https://github.com/knpkv/npm/commit/f820c1906e00f2f2d17c2e7cc3921ba26522db43), [`665cecb`](https://github.com/knpkv/npm/commit/665cecbc3d5f79f9083acb1b393ace9a8ec0b1b8), [`f820c19`](https://github.com/knpkv/npm/commit/f820c1906e00f2f2d17c2e7cc3921ba26522db43), [`1bba5c2`](https://github.com/knpkv/npm/commit/1bba5c282684553fbc670e6dcf2960e8a4e200ed)]:
  - @knpkv/jira-api-client@1.0.0
  - @knpkv/atlassian-common@1.2.0
  - @knpkv/agent-skills@0.2.3

## 1.2.0

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
  - @knpkv/jira-api-client@0.4.0

## 1.1.2

### Patch Changes

- Updated dependencies [[`f7534ae`](https://github.com/knpkv/npm/commit/f7534ae868a010274f9c4a49ef95bd96e9a26506)]:
  - @knpkv/jira-api-client@0.3.1

## 1.1.1

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

- [#97](https://github.com/knpkv/npm/pull/97) [`0eec900`](https://github.com/knpkv/npm/commit/0eec9001c32e70493be985449798d731f7dfb9ba) Thanks [@konopkov](https://github.com/konopkov)! - Fix `serializeIssue` crashing with `yaml.safeDump is removed in js-yaml 4`. gray-matter's default YAML engine calls js-yaml 3's `safeDump`/`safeLoad`, both removed in js-yaml 4 — which the workspace pins via a security override. The front-matter writer now supplies a custom engine backed by js-yaml 4's `dump`/`load`.

- [#98](https://github.com/knpkv/npm/pull/98) [`fdfd789`](https://github.com/knpkv/npm/commit/fdfd7897442a4616087463c60ae54d94f1726dd3) Thanks [@konopkov](https://github.com/konopkov)! - Add Jira Markdown Sync workspace primitives, field reconciliation helpers, and a live Jira integration test using `JIRA_API_KEY`.

- Updated dependencies [[`59478b0`](https://github.com/knpkv/npm/commit/59478b0d059d359feaf38222e5e55f748ee389d7)]:
  - @knpkv/agent-skills@0.2.1

## 0.3.0

### Minor Changes

- [#81](https://github.com/knpkv/npm/pull/81) [`19c1538`](https://github.com/knpkv/npm/commit/19c153835bc198b9e407a013c16775c3fb7eb357) Thanks [@konopkov](https://github.com/konopkov)! - Ship agent skills alongside each CLI package and add an installer package plus per-CLI `skills install` commands for Codex and Claude.

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

- Updated dependencies [[`c697d3c`](https://github.com/knpkv/npm/commit/c697d3c4ab779f14f017d3ec8fc8d1bffa1493b5), [`19c1538`](https://github.com/knpkv/npm/commit/19c153835bc198b9e407a013c16775c3fb7eb357), [`e3c3805`](https://github.com/knpkv/npm/commit/e3c3805ee527a6edb69ed91977c95c586b563ff9)]:
  - @knpkv/agent-skills@0.2.0
  - @knpkv/atlassian-common@0.3.0
  - @knpkv/jira-api-client@0.3.0

## 0.2.0

### Minor Changes

- [#69](https://github.com/knpkv/npm/pull/69) [`ebe2800`](https://github.com/knpkv/npm/commit/ebe280079863e7236de20bf06c0db6446215dab1) Thanks @konopkov! - Add a `jira version` command for working with Jira project versions (releases),
  backed by a new `VersionService`.
  - `jira version list --project KEY` lists versions with Driver, Contributors and
    Approver fields resolved to display names. `--released`/`--unreleased` filter
    by state, `--custom-field "<name>"` (repeatable) includes per-ticket custom
    field values, and `--json` emits the raw objects.
  - `jira version view <id>` shows a single version.
  - `jira version set <id> --description <text>` edits the description.
  - `jira version relatedwork list|add <id>` manages "Related work" links (the
    Confluence pages surfaced on a release report).

  `version set` requires the new `manage:jira-project` OAuth scope. `relatedwork
add` uses the existing `write:jira-work` scope. Re-run `jira auth login` to
  grant the new scope.

## 0.1.1

### Patch Changes

- Updated dependencies [[`fc7be8f`](https://github.com/knpkv/npm/commit/fc7be8ffaf5b6b094c7f81551e8ace6f2a8f2c4c)]:
  - @knpkv/atlassian-common@0.2.0
  - @knpkv/jira-api-client@0.2.0
