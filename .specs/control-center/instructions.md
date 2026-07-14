# Control Center — Feature Instructions

## Overview

Build a production `@knpkv/control-center` application, the independent **rly** design-system package `@knpkv/rly`, and separate local Effect AI CLI provider packages `@knpkv/cdx` and `@knpkv/cld` from the approved Control Center prototype. The application is a human- and agent-oriented delivery super-app that connects CodeCommit, CodePipeline, Jira, Confluence, and Clockify through explicit plugin boundaries. It must provide a web UI and an application server, reuse rly/provider/existing workspace packages through supported exports, and replace prototype-only data and `localStorage` behavior with typed server APIs and durable application state.

The committed prototype at `packages/codecommit-web/src/client/prototypes/control-center/` is the visual and interaction reference. Production implementation may simplify internal code and data flow, but must preserve the approved information hierarchy, entity relationships, human collaboration model, agent workflows, light/dark themes, and responsive behavior.

## User Story

As an engineering release owner, reviewer, or approver, I want one Control Center that connects work definition, code changes, documentation, pipeline executions, releases, time evidence, collaborators, and governed agents so that I can understand what can ship, trace why, act on blockers, and review evidence without switching between service-specific tools.

As an agent, I need a typed, scoped release context and governed plugin actions so that I can inspect evidence, propose or execute approved work, and leave an auditable thread without confusing one release, issue, pull request, or environment with another.

## Core Requirements

### Product shell and navigation

- Provide a canonical Control Center web application with Overview, Release, Active work, Items, Timeline, Settings, and full entity routes.
- Every release status row must open a compact preview before the user explicitly opens the full release view.
- Routes for releases and service entities must be stable, refreshable, and preserve their origin when navigating back.
- Provide responsive desktop and mobile layouts with complete keyboard navigation, focus management, reduced-motion support, and accessible names/status announcements.
- Provide persistent light and dark themes with a reachable toggle on desktop and mobile.

### Delivery graph and traceability

- Model Jira issues, CodeCommit pull requests and commits, Confluence pages, CodePipeline executions and stages, Clockify entries/rollups, releases, environments, collaborators, evidence, and agent activity as typed entities.
- Support many-to-many relationships and immutable evidence rather than relying on name matching alone.
- Show a bird's-eye release portfolio and a compact six-Jira-item release fixture that makes Jira → PR → pipeline → release/environment relationships immediately visible.
- Distinguish missing, inferred, proposed, verified, and governed relationships.
- Derive release readiness from evidence and environment-specific delivery state rather than a manually copied verdict.

### Service plugins

- Define a versioned plugin contract for discovery, read models, events, capabilities, health, and governed actions.
- Ship first-party plugins for CodeCommit, CodePipeline, Jira, Confluence, and Clockify by adapting existing workspace clients/packages where possible.
- Keep service-specific authentication, pagination, rate limits, errors, and normalization behind plugin boundaries.
- Allow plugins to be enabled, disabled, configured, and health-checked without coupling the application core to vendor response shapes.
- Validate all plugin and HTTP boundary data before it enters trusted domain state.

### Full service views

- Provide full CodeCommit PR, Jira issue, Confluence page, CodePipeline execution, and Clockify views using the rly design system.
- Jira must include description editing, acceptance criteria, comments, threaded replies, history, structured fields, and linked delivery evidence.
- CodeCommit PR must include human review state, sandboxed agent review, file navigation, split/stacked diffs, findings, request-changes, and approval states.
- Confluence must show readable page content, revision/history, runbook evidence, contributors, and approvers.
- CodePipeline must show stages, executions, logs, artifacts, environment state, operators, and deployment approvers.
- Clockify must show entries/rollups, contributors, ticket associations, and approval/evidence status.

### Human collaboration

- Make release owners, issue owners, authors, contributors, reviewers, operators, and approvers visible in relevant overview and full views.
- Use consistent collaborator components with avatars, names, and explicit role labels.
- Ensure approvals and review lifecycle states are per entity and persist across navigation and restart.

### Agents and automation

- Make the agent a first-class participant on every page with explicit current release/entity context.
- Provide one durable agent thread per release, including evidence refreshes and actions such as updating descriptions, running checks, and summarizing blockers.
- Support sandboxed PR review that can continue in the background and persist findings and decisions.
- Require explicit intent for remote mutations and present the exact target, evidence, proposed change, permission requirement, and audit outcome.
- Persist agent activity, approvals, proposals, and results in an auditable timeline.
- Require every agent-authored review finding to propose how the defect class could be prevented through ast-grep, ESLint, type checking, a focused test, or a repository agent instruction. When a finding is accepted and the proposal is stable, ship the durable guardrail with the remediation; otherwise record why automation would be brittle or misleading.
- Prevent cross-release state leakage and stale or malformed persisted agent state from crashing the application.
- Provide local Codex and Claude integrations as separate `cdx` and `cld` packages exposing Effect AI-compatible `LanguageModel` layers with structured streaming, cancellation, capability/version health, and bounded scoped processes.
- Keep local CLI agents read/analyze/propose-only by default; never enable permission/sandbox bypass flags or let them authorize vendor mutations.

### Release identity and presentation

- Give every release a deterministic, stable three-symbol SVG sigil and short codename derived from release identity.
- Preserve service colors as semantic accents while keeping the overall interface quiet, minimal, and typography-led.
- Reuse the approved preview-to-full transition with a reduced-motion fallback.

### Application server and persistence

- Provide an application server that serves the web application and typed APIs for portfolio data, entity detail, plugin configuration/health, relationships, evidence, agent threads, settings, and governed actions.
- Support live updates for long-running plugin sync, pipeline activity, and agent work without requiring a full page reload.
- Persist application settings, normalized entity state, relationship evidence, review/approval state, agent threads, and audit events outside the browser.
- Bind to a configurable host/port so the application can be used from another machine on the same network when explicitly configured.
- Handle partial plugin failure without taking down unrelated service views.

### Design system first

- Create reusable rly tokens and components before assembling production pages.
- At minimum cover typography, color/theme tokens, spacing, surfaces, buttons, icon/service badges, status/verdict treatments, avatars/collaborators, tabs, entity chains, release sigils, dialogs/sheets, agent messages/threads, timeline rows, tables/lists, forms, empty/error/loading states, and diff primitives.
- Production pages must compose these components as reusable building blocks rather than copy prototype markup and CSS wholesale.
- rly components must be documented, mechanically registered, and tested independently.

## Technical Specifications

- Working application package location/name: `packages/control-center` / `@knpkv/control-center`.
- Working design-system package location/name: `packages/rly` / `@knpkv/rly`, product name **rly**. It SHALL remain browser-safe and independently consumable; the application consumes it through supported exports.
- Working local provider package locations/names: `packages/cdx` / `@knpkv/cdx` for Codex and `packages/cld` / `@knpkv/cld` for Claude. Each SHALL independently provide an Effect AI-compatible server-side layer and SHALL NOT depend on Control Center or rly.
- Add indexed Astro/Starlight documentation-site pages for Control Center, rly, cdx, and cld with installation, exports, examples, safety/capability notes, and cross-links from the package index; READMEs alone are insufficient.
- Language/runtime: strict TypeScript, React web client, Effect-based application server and services, Vite client build, and Vitest tests.
- Follow repository Effect guardrails, Ockto TypeScript guidelines, package export rules, and existing workspace conventions.
- Use named exports and define both `main` and `exports` in every new package manifest.
- Use Effect Platform services for server I/O, time, HTTP, configuration, filesystem, and process access.
- Decode untrusted HTTP, plugin, configuration, and persisted data at boundaries before assigning domain types.
- Existing packages may be extended when a reusable capability belongs with their product client, but vendor-specific behavior must not leak into Control Center core models.
- The prototype remains a design fixture until equivalent production routes are verified; its mock state is not a production data source.

## Acceptance Criteria

1. A fresh install can configure at least one plugin, start the app server, open the web UI, and see plugin health plus normalized release data.
2. The portfolio renders releases from server data and opens every release through preview → full view with stable URLs and correct back behavior.
3. A release fixture with six Jira items visibly connects issues, multiple PRs, a pipeline execution, documentation, collaborators, and environment state.
4. Full Jira, PR, Confluence, CodePipeline, and Clockify routes load through typed APIs and retain state across refresh.
5. A user can inspect and repair a missing relationship with explicit target/evidence and an audit entry.
6. A PR agent review checks out an isolated sandbox, continues in the background, returns file-specific findings, and records request-changes or approval.
7. A release-scoped agent thread persists independently from every other release and never references another release's evidence.
8. A governed remote action cannot execute without explicit user intent and a recorded target/outcome.
9. Light and dark themes are complete and usable on desktop and mobile; keyboard-only flows work for navigation, previews, dialogs, entity actions, and agent review.
10. Disabling or failing one plugin produces a scoped health/error state while other plugins and cached release data remain usable.
11. Production pages are built from documented rly components; duplicated page-specific primitives are rejected in review.
12. All four new packages pass repository formatting, lint, AST rules, type checks, applicable unit/integration/component/process tests, production builds, package-integrity checks, and applicable end-to-end acceptance tests.

## Out of Scope

- Replacing Jira, Confluence, CodeCommit, CodePipeline, or Clockify as systems of record.
- Supporting third-party services beyond the five named first-party plugins in the initial implementation.
- Autonomous remote mutation without explicit intent, policy checks, and audit evidence.
- Native mobile applications.
- Cloud infrastructure or a hosted multi-tenant SaaS deployment in the initial package implementation.
- Pixel-for-pixel preservation of prototype internals or its accumulated CSS cascade.

## Success Metrics

- A release owner can answer “what can ship, what is blocked, who owns it, and where has it deployed?” from the portfolio and one release view.
- A reviewer can navigate from Jira issue to PR diff, pipeline execution, runbook, and release without losing context.
- All five first-party plugins expose health and normalized read data through the same application contract.
- Every remote mutation and agent action is attributable, scoped, and auditable.
- No production page depends on prototype mock collections or browser-only persistence.
- rly primitives are reused across all service and release views and pass accessibility/theme tests.
- The documentation website includes accurate, searchable pages for all four new packages, including the real local cdx smoke workflow.

## Testing Requirements

- Unit tests for domain normalization, release-readiness derivation, relationship/evidence semantics, permissions, release identity, and plugin contracts.
- Contract tests for each first-party plugin adapter using representative vendor fixtures and error/rate-limit cases.
- Fake-executable Effect AI contract/pack/process tests for cdx and cld, plus a deliberate real local Codex smoke test through the packaged cdx layer in an ephemeral read-only repository.
- Application-server tests for API decoding, configuration, persistence, partial plugin failure, action governance, and live-update behavior.
- React component tests for every rly primitive, including light/dark, keyboard, focus, reduced-motion, loading, empty, and error states; plus manifest/registry drift, semantic-token lint, public export, packed-consumer, and package-boundary tests.
- Page integration tests for portfolio, release preview/full, Active work, Items, Timeline, Settings, and all five full service views.
- End-to-end tests for six-item release traceability, relationship repair, approval persistence, sandbox agent review, agent thread isolation, back/refresh routing, and mobile theme access.
- Regression tests for malformed persisted/plugin data, cross-release leakage, multi-PR merge gates, background agent work, and reset/recovery behavior.
- Full repository format, lint, AST, type-check, test, build, changeset, and dependency-audit validation before PR completion.
