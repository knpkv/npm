# @knpkv/clockify-api-client

## 3.0.0

### Major Changes

- [#521](https://github.com/knpkv/npm/pull/521) [`28c22ae`](https://github.com/knpkv/npm/commit/28c22ae49825b06472c0d35aa9d7ef92ed5748ff) Thanks [@konopkov](https://github.com/konopkov)! - `jcf auth clockify setup` reported "No workspaces found." and saved nothing, even when the key had workspaces. The generated client could not decode a real `/v1/workspaces` response, and setup turned that failure into an empty list.

  - **`@knpkv/clockify-api-client`**: `WorkspaceDtoV1` now matches what the API returns.
    - `featureSubscriptionType` is a `string` (e.g. `FREE_2026`), not a `FeaturePlan` object.
    - `features` is a `ReadonlyArray<string>`.
    - `workspaceSettings` is no longer modelled, because the upstream schema disagrees with live responses on many nullable and enum fields.
    - `MembershipDtoV1.costRate` and `hourlyRate`, and `WorkspaceSubdomainDtoV1.name`, accept `null`.
    - `FeaturePlan` and `WorkspaceSettingsDtoV1` stay exported.
    - These are incompatible type changes to exported generated schemas, so this is a major release. The previous types could not decode a real response, so code relying on them could not have run.
  - **`@knpkv/jira-clockify`**: setup now fails with a typed `ClockifyRequestError` that names the failed request, instead of reporting no workspaces. "Invalid API key" is reported only when Clockify rejects the key with 401 or 403; before, any failure looked up the user as an invalid key. The account lookup is exported as `loadClockifyAccount`, so it can be tested against real-shaped responses.

- [#483](https://github.com/knpkv/npm/pull/483) [`da0e5ff`](https://github.com/knpkv/npm/commit/da0e5ff70ec5926beaeceff060a37b2b0f27b6f9) Thanks [@konopkov](https://github.com/konopkov)! - Discover every worked ticket from Claude Code and Codex sessions.

  Presence is now a supervised turn: a typed prompt, including one queued while the agent was busy, opens a turn and the agent's work inside it counts until the turn ends, a task notification or auto-continuation takes over, or the idle cap passes. Task notifications, auto-continuations and `isMeta` lines no longer count as typed. Legacy Codex tool-call response items keep a turn alive. `decodeTranscript` now requires `idleCapMs`; `decodeSessionLines` and `SessionLine` are new.

  Parallel stretches no longer drop tickets: every attributed ticket keeps a share, overlapping short tickets stay co-owners, and the web calendar shows suggestions down to Jira's one-minute minimum. When minutes are scarce, open-sprint tickets assigned to you rank first, then tickets not yet logged that day; the same facts appear as tie-breakers in the attribution prompt. Inside one unbroken stretch each ticket now gets a single block, ordered by first activity and packed with no gaps; a ticket that cannot reach a minute folds into the one ranked above it.

  Ignore a ticket in every week with `jcf config set session-ignore <KEY>` or the web's Ignore button, and restore it from the Ignored tickets list. An ignored ticket is never suggested or offered to the attribution agent; a branch or path match to it falls through to the session's other candidates, and its parallel time goes to the tickets it ran alongside. Reports carry its raw time as `ignored`. In the web calendar, back-to-back short suggestions show as one card per stretch, and the page uses the full window width.

  An orchestrating session nothing else places is split across the open-sprint tickets it mentions, by mention count, per active stretch (new attribution signal `split`); deterministic reads such as `jcf watch` leave it unplaced. The web lists low-confidence matches with a "Log as" action, and saved entries can be deleted or moved to another ticket; a delete releases its session claim so the time is suggested again, and a move carries the claim to the replacement. `SavedEntries` gains `remove` and an optional `ticketKey` on update.

  Quick approvals are confirmed in batches of up to fifty under one provider re-read (new `/api/rows/confirm-batch`), Jira worklogs are read eight issues at a time, and idempotent Jira reads retry a dropped connection twice, so a long queue no longer waits on one full re-read per approval.

  A provider window that needs manual review no longer fails a read: proposals carry a per-provider `writeBlocked` hold, the web shows the hold and disables writes to held providers, and writes keep refusing.

  Ticket moves persist a replacement intent before creating provider time. Uncertain or partial moves stay held across restart and cannot create another replacement on retry; a verified pair can be resolved by explicitly deleting either entry. Ordinary replacements retain their verified ID and start so extending a reviewed window does not mistake the move for unknown earlier time. The private source ledger upgrades to version 5 while retaining existing claims and holds.

  Breaking (`@knpkv/clockify-api-client`): `TimeEntryWithRatesDtoV1.costRate` and `hourlyRate` are now `RateDtoV1 | null`, matching the live API, which returns `null` when no rate applies.

## 2.0.0

### Major Changes

- [#377](https://github.com/knpkv/npm/pull/377) [`bd45f8c`](https://github.com/knpkv/npm/commit/bd45f8cdeb1e8301bfcde42254792a488734d7e5) Thanks [@konopkov](https://github.com/konopkov)! - Update the generated Clockify API client from the latest OpenAPI specification and decode workspace feature plans as objects.

  Breaking: the published `./generated` entry point removes upstream models including `AmountDto`, `AttendanceDto`, `BalanceDtoV1`, `SharedReportDtoV1`, and `TimeEntryDto`. Consumers importing generated models must update their imports and check the regenerated request and response schemas before upgrading.

### Minor Changes

- [#439](https://github.com/knpkv/npm/pull/439) [`e17fbbb`](https://github.com/knpkv/npm/commit/e17fbbb8760f5f8bcf9a73b7d2d11a526c37fadd) Thanks [@github-actions](https://github.com/apps/github-actions)! - Update the generated Clockify API client from the latest OpenAPI specification: time intervals expose zoned start and end times, time-off status changes carry their time zone, templates and approval requests accept a time view mode, and feature plans include `ACTIVITY_MONITORING`.

- [#452](https://github.com/knpkv/npm/pull/452) [`755eafa`](https://github.com/knpkv/npm/commit/755eafab8c0bc3e82b00e2dd27c68d669a1de87e) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade to Effect 4.0.0 stable. `effect` and every `@effect/*` dependency or peer dependency now require `4.0.0`; imports move from the removed `effect/unstable/*` paths to `effect/*`.

### Patch Changes

- [#376](https://github.com/knpkv/npm/pull/376) [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183) Thanks [@konopkov](https://github.com/konopkov)! - Replace internal project names, keys and work descriptions in fixtures, examples and documentation
  with neutral placeholders. Nothing about behaviour changes; these are the strings a reader of a
  public package would otherwise see.

  `ClockifyApiClient`'s tests now compose their client once through `it.layer`, with each case
  declaring the response it wants, instead of providing a layer inside every test body.

## 1.1.1

### Patch Changes

- [#361](https://github.com/knpkv/npm/pull/361) [`676419e`](https://github.com/knpkv/npm/commit/676419e39c395dd4cfea6d9ffaee7d002a3f75e2) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade the workspace to Effect 4.0.0-rc.109, pin the vendored Effect reference to that exact upstream release, guard source/package alignment, and bound Control Center test concurrency for reliable CI execution.

## 1.1.0

### Minor Changes

- [#370](https://github.com/knpkv/npm/pull/370) [`27d2ca1`](https://github.com/knpkv/npm/commit/27d2ca18b0c0b0f8a252d461c0aaf10eb92e9ffc) Thanks [@konopkov](https://github.com/konopkov)! - Enforce the complete anti-slop rule set with zero accepted diagnostics and update affected APIs and implementations to satisfy the required contracts.

### Patch Changes

- [#361](https://github.com/knpkv/npm/pull/361) [`676419e`](https://github.com/knpkv/npm/commit/676419e39c395dd4cfea6d9ffaee7d002a3f75e2) Thanks [@konopkov](https://github.com/konopkov)! - Update Effect and effect-qb, migrate schema-tagged errors to the current Effect API, and adopt the dialect-scoped SQLite function and type APIs introduced by effect-qb 0.22.

## 1.0.3

### Patch Changes

- [#260](https://github.com/knpkv/npm/pull/260) [`38848a2`](https://github.com/knpkv/npm/commit/38848a2660aa98295f96d54d232e4cec15ea95a5) Thanks [@konopkov](https://github.com/konopkov)! - Add a read-first Clockify time-entry page with deterministic totals, source facts, people roles, and explicit Jira attribution states.

- [#303](https://github.com/knpkv/npm/pull/303) [`ad10dc7`](https://github.com/knpkv/npm/commit/ad10dc767d4c512186e47eeea5237a1e4c84e798) Thanks [@konopkov](https://github.com/konopkov)! - Add governed Clockify association correction and revision-scoped Control Center approval, with hydrated
  time-entry reads for canonical revisions and safe replacement updates.

## 1.0.2

### Patch Changes

- [#253](https://github.com/knpkv/npm/pull/253) [`521c44e`](https://github.com/knpkv/npm/commit/521c44e9b9d6f4adc3e5ba44f1d9f117698d4442) Thanks [@konopkov](https://github.com/konopkov)! - Update the generated Clockify API client from the latest OpenAPI specification.

## 1.0.1

### Patch Changes

- [#249](https://github.com/knpkv/npm/pull/249) [`5a61061`](https://github.com/knpkv/npm/commit/5a610619cef7609148b396d9248924422138221b) Thanks [@konopkov](https://github.com/konopkov)! - Fix `jcf` commands failing to decode Clockify time-entry responses when optional
  fields come back as explicit `null`:

  - `jcf timer start` failed with `Expected string, got null at ["kioskId"]` —
    Clockify returns `kioskId`, `projectId`, and `taskId` as `null` (not absent).
  - `jcf sync reconcile` failed with `Expected array, got null at [0]["tagIds"]` —
    Clockify returns `tagIds` as `null` for entries with no tags.

  Patch the OpenAPI spec so those fields decode as nullable across the time-entry
  response schemas (`TimeEntryDtoImplV1`, `TimeEntryDtoV1`,
  `TimeEntryWithRatesDtoV1`) and regenerate the client.

  Also stop `jcf timer start` from printing a misleading `Timer started` line
  after the start actually failed.

## 1.0.0

### Major Changes

- [#125](https://github.com/knpkv/npm/pull/125) [`f820c19`](https://github.com/knpkv/npm/commit/f820c1906e00f2f2d17c2e7cc3921ba26522db43) Thanks [@konopkov](https://github.com/konopkov)! - Replace the openapi-fetch Clockify surface with a Schema-validated client generated by Effect's official OpenAPI generator. The old raw client, `ClockifyApiError`, `toEffect`, and `FetchClientError` exports are removed; consumers now use the generated `ClockifyApi` operations or the authenticated service conveniences.

### Patch Changes

- [#125](https://github.com/knpkv/npm/pull/125) [`f820c19`](https://github.com/knpkv/npm/commit/f820c1906e00f2f2d17c2e7cc3921ba26522db43) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade the workspace to Effect 4.0.0-beta.98 and current compatible dependencies. Replace ad hoc object guards with Effect Predicate helpers and migrate retry schedules to the current Schedule API.

## 0.3.0

### Minor Changes

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

## 0.2.0

### Minor Changes

- [#61](https://github.com/knpkv/npm/pull/61) [`fc7be8f`](https://github.com/knpkv/npm/commit/fc7be8ffaf5b6b094c7f81551e8ace6f2a8f2c4c) Thanks @konopkov! - feat: add jira-api-client and atlassian-common packages
  - New @knpkv/atlassian-common: shared AST types, serializers, auth, and config
  - New @knpkv/jira-api-client: Effect-based Jira REST API client (openapi-gen)
  - Updated @knpkv/confluence-api-client: regenerated with openapi-gen
  - Updated @knpkv/confluence-to-markdown: use new generated API client
