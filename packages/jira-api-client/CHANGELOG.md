# @knpkv/jira-api-client

## 2.1.1

### Patch Changes

- [#581](https://github.com/knpkv/npm/pull/581) [`c22e8ae`](https://github.com/knpkv/npm/commit/c22e8ae0c55a50e9c1edbd46a1cd18108f62e4fa) Thanks [@konopkov](https://github.com/konopkov)! - Mark existing silent fallbacks (failures turned into success without a log) with a follow-up lint suppression. No behaviour change.

## 2.1.0

### Minor Changes

- [#540](https://github.com/knpkv/npm/pull/540) [`0573403`](https://github.com/knpkv/npm/commit/057340343fcc727fd0c56329d840a668170376ad) Thanks [@konopkov](https://github.com/konopkov)! - Connect Jira with an API token, and set up each system on its own:

  - `jcf auth jira token` asks for your Jira address, email and an API token, checks them with Jira, and saves them to `~/.jcf/jira.json` (owner-only). The token is never printed. Classic and scoped tokens both work; a scoped token is used through Atlassian's gateway for the site. A failed check says whether the site, the token or the network was wrong. The OAuth app (`create`, `configure`, `login`) stays as the advanced option; when both exist the token is used.
  - `jcf` with nothing connected asks about Jira and Clockify in turn, and either can be skipped. With one connected it opens straight away. Without a terminal it prints both commands and exits 1.
  - Commands that need Jira (`issue list`, `timer start`, `sync reconcile`) fail with "Jira is not connected. Run jcf auth jira token to connect it." and exit 1, instead of reporting no issues. `auth clockify setup` takes `--api-key` and fails without a terminal. Failed `timer` and `config set project` steps and a failed reconcile exit non-zero.
  - `jcf auth status` names the Clockify workspace and the next command for anything not connected. Every command has a help description, and `--version` reports the package version.
  - `@knpkv/jira-api-client`: a basic-auth credential may carry its `siteUrl`, used as the request host, so a credential re-read per request keeps its site.
  - `@knpkv/agent-skills`: the jcf skill names `jcf auth jira token` as the way to connect Jira.

## 2.0.0

### Major Changes

- [#438](https://github.com/knpkv/npm/pull/438) [`acb8b25`](https://github.com/knpkv/npm/commit/acb8b25772cc188a0cc1299a1b591903240cfc7c) Thanks [@github-actions](https://github.com/apps/github-actions)! - Update the generated Schema-backed Jira API client.

  Breaking: these exported types now include `null`, so code that reads them must handle it: `ApprovalConfiguration`, `BoardFeaturesPayload`, `BoardsPayload`, `ConditionGroupConfiguration`, `ConditionGroupUpdate`, `CustomFieldPayload`, `FieldCapabilityPayload`, `FieldLayoutPayload`, `FieldLayoutSchemePayload`, `FieldSchemePayload`, `IssueLayoutPayload`, `IssueTypeHierarchyPayload`, `IssueTypePayload`, `IssueTypeProjectCreatePayload`, `IssueTypeScreenSchemePayload`, `NotificationSchemePayload`, `PermissionPayloadDTO`, `PreviewConditionGroupConfiguration`, `PreviewRuleConfiguration`, `ProjectId`, `RolesCapabilityPayload`, `ScopePayload`, `ScreenPayload`, `ScreenSchemePayload`, `SecuritySchemePayload`, `TargetClassification`, `TargetMandatoryFields`, `TargetStatus`, `WorkflowCapabilityPayload`, `WorkflowLayout`, `WorkflowProjectIdScope`, `WorkflowRuleConfiguration`, `WorkflowStatusLayout`, and `WorkflowTransitionLinks`. `ProjectId` and `WorkflowLayout` also appear in responses. No exports are removed; 129 are added.

### Minor Changes

- [#452](https://github.com/knpkv/npm/pull/452) [`755eafa`](https://github.com/knpkv/npm/commit/755eafab8c0bc3e82b00e2dd27c68d669a1de87e) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade to Effect 4.0.0 stable. `effect` and every `@effect/*` dependency or peer dependency now require `4.0.0`; imports move from the removed `effect/unstable/*` paths to `effect/*`.

- [#376](https://github.com/knpkv/npm/pull/376) [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183) Thanks [@konopkov](https://github.com/konopkov)! - Let a client re-read its credential per request. `JiraApiConfigContract` gains an optional
  `resolveAuth`, and the credential union it yields is now exported as `JiraApiCredential`.

  Without it, a client is pinned for life to the token that existed when its layer was built. That is
  invisible in a command that exits in seconds and fatal in one that does not: an Atlassian access
  token lasts about an hour, after which every request 401s and no retry inside the process can
  recover, because the expired token is already baked into the header. `jcf watch` is meant to run all
  day.

  Omitting `resolveAuth` keeps the previous behaviour exactly — the credential in `auth` is used as
  given, which is right for a basic-auth API token that cannot expire. When it is supplied, both the
  `Authorization` header and the API host are derived from the same resolved value, so a resolver
  cannot address one site while authenticating against another.

- [#452](https://github.com/knpkv/npm/pull/452) [`755eafa`](https://github.com/knpkv/npm/commit/755eafab8c0bc3e82b00e2dd27c68d669a1de87e) Thanks [@konopkov](https://github.com/konopkov)! - Decode Jira change items that omit `toString`. Effect 4.0.0 reads declared struct keys through the prototype, so an omitted `toString` resolved to `Object.prototype.toString` and failed decoding. The new `ownOptionalKey` schema treats that inherited member as an absent key.

## 1.1.1

### Patch Changes

- [#361](https://github.com/knpkv/npm/pull/361) [`676419e`](https://github.com/knpkv/npm/commit/676419e39c395dd4cfea6d9ffaee7d002a3f75e2) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade the workspace to Effect 4.0.0-rc.109, pin the vendored Effect reference to that exact upstream release, guard source/package alignment, and bound Control Center test concurrency for reliable CI execution.

## 1.1.0

### Minor Changes

- [#370](https://github.com/knpkv/npm/pull/370) [`27d2ca1`](https://github.com/knpkv/npm/commit/27d2ca18b0c0b0f8a252d461c0aaf10eb92e9ffc) Thanks [@konopkov](https://github.com/konopkov)! - Enforce the complete anti-slop rule set with zero accepted diagnostics and update affected APIs and implementations to satisfy the required contracts.

### Patch Changes

- [#361](https://github.com/knpkv/npm/pull/361) [`676419e`](https://github.com/knpkv/npm/commit/676419e39c395dd4cfea6d9ffaee7d002a3f75e2) Thanks [@konopkov](https://github.com/konopkov)! - Update Effect and effect-qb, migrate schema-tagged errors to the current Effect API, and adopt the dialect-scoped SQLite function and type APIs introduced by effect-qb 0.22.

## 1.0.1

### Patch Changes

- [#252](https://github.com/knpkv/npm/pull/252) [`6d510c9`](https://github.com/knpkv/npm/commit/6d510c9d3dab3e459db7fa1d25cd12f0e122699e) Thanks [@konopkov](https://github.com/konopkov)! - Update the generated Schema-backed Jira API client.

## 1.0.0

### Major Changes

- [#125](https://github.com/knpkv/npm/pull/125) [`f820c19`](https://github.com/knpkv/npm/commit/f820c1906e00f2f2d17c2e7cc3921ba26522db43) Thanks [@konopkov](https://github.com/konopkov)! - Replace the legacy Atlassian `openapi-fetch` clients with generated,
  Schema-validated Effect clients. Jira and Confluence now provide direct Effect
  operations, injected `HttpClient` transports, deterministic local regeneration,
  structural upstream freshness checks, and scheduled tested update pull requests.

  The legacy `toEffect`, `FetchClientError`, raw `.client` operation surface, and
  type-only generated subpaths are removed.

### Patch Changes

- [#125](https://github.com/knpkv/npm/pull/125) [`f820c19`](https://github.com/knpkv/npm/commit/f820c1906e00f2f2d17c2e7cc3921ba26522db43) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade the workspace to Effect 4.0.0-beta.98 and current compatible dependencies. Replace ad hoc object guards with Effect Predicate helpers and migrate retry schedules to the current Schedule API.

## 0.4.0

### Minor Changes

- [#114](https://github.com/knpkv/npm/pull/114) [`904d3d7`](https://github.com/knpkv/npm/commit/904d3d75948d94558484094cf225b5ea6585663e) Thanks [@konopkov](https://github.com/konopkov)! - Add Jira and Confluence attachment support.

  - Add shared attachment rendering and placeholder replacement helpers.
  - Support multipart attachment upload calls in Jira and Confluence API clients.
  - Render Jira attachments as inline image previews or links with hidden attachment metadata.
  - Resolve Confluence media attachments to visible Markdown previews while preserving native media ADF identity.
  - Add explicit Jira and Confluence attachment upload commands with optional Markdown placeholder insertion.

## 0.3.1

### Patch Changes

- [#111](https://github.com/knpkv/npm/pull/111) [`f7534ae`](https://github.com/knpkv/npm/commit/f7534ae868a010274f9c4a49ef95bd96e9a26506) Thanks [@github-actions](https://github.com/apps/github-actions)! - Update generated Jira API OpenAPI specs.

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
