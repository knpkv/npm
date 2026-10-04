# @knpkv/clockify-api-client

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
