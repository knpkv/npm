# @knpkv/rly

`rly` is the release-oriented design system for `@knpkv/control-center`. It provides browser-safe presentation contracts for delivery decisions, service provenance, collaborators, governed agents, and complete pull-request diffs.

The package is intentionally application-independent: it contains no vendor clients, persistence, authorization, release hashing, or server runtime.

## Status

The first `0.1.0` surface is complete behind the package's `0.0.0`
development version. Tokens, foundations, primitives, delivery patterns,
contextual-agent patterns, and the isolated diff workbench are available
through explicit, generated exports. The package remains presentation-only;
application and provider integrations live outside rly.

## Tokens and global styles

Import browser-safe semantic token names from `@knpkv/rly/tokens`. Raw palette
values remain private and are emitted only into the generated CSS contract.

Import the global layers once at the application boundary:

```css
@import "@knpkv/rly/styles.css";
```

The stylesheet contains self-hosted Geist and Geist Mono variable fonts,
semantic `light-dark()` color pairs, typography, spacing, shape, motion, a
scoped reset, and base styles. Set `data-theme="light|dark|system"` on the rly
root; system is the default. Forced colors and reduced motion are handled
centrally.

Service accents identify provenance only. Readiness always uses a state word,
ink/tint pair, and geometry rather than a provider color.

Token sources, CSS, registry metadata, package exports, and visual catalog data
are generated together:

```bash
pnpm --filter @knpkv/rly codegen:check
pnpm --filter @knpkv/rly lint:colors
```

The color-policy lint rejects raw component colors, primitive palette
variables, and component-local theme/media overrides.

## Foundations

Import the stylesheet once, then establish an explicit controlled theme scope:

```tsx
import { Icon, LinkProvider, PortalProvider, ThemeProvider, type RlyLinkProps } from "@knpkv/rly"

const AppLink = ({ href, ...props }: RlyLinkProps) => <a {...props} href={href} />

export const App = () => (
  <ThemeProvider theme="system">
    <LinkProvider component={AppLink}>
      <PortalProvider>
        <Icon decorative name="check" />
        Ready
      </PortalProvider>
    </LinkProvider>
  </ThemeProvider>
)
```

`ThemeProvider` is controlled and performs no storage or preference reads.
`LinkProvider` accepts an application-owned anchor bridge without importing a
router. `PortalProvider` owns an in-tree target unless a custom target is
supplied; explicit `null` never falls back to the global document body. `Icon`
publishes an owned name and size vocabulary rather than vendor types.

## Primitives

The primitive layer stays deliberately small: typography, surfaces, dividers,
buttons, state presentation, avatars, deterministic loading geometry, tabs,
form controls, and modal overlays. Each component exposes an owned variant
vocabulary and ordinary React DOM props without leaking Radix or icon-library
types.

```tsx
import { Avatar, Button, StateLabel, Surface, Text } from "@knpkv/rly/primitives"

export const Decision = () => (
  <Surface padding="spacious" shape="grouped">
    <Text as="h2" variant="section-title">
      Ready for review
    </Text>
    <StateLabel label="Waiting for confirmation" tone="progress" />
    <Avatar fallback="AK" label="Alex Kim" />
    <Button leadingIcon="check" size="principal" variant="primary">
      Approve changes
    </Button>
  </Surface>
)
```

Import `@knpkv/rly/styles.css` once to load every primitive style through the
stable component layer. Components never inject styles at runtime, and the
published JavaScript remains safe to import during SSR.

Interactive state is controlled first. `Tabs` and `Select` accept an optional
default only for reusable local ownership; controlled values require their
change callback. `Field` supplies the exact id and ARIA props to a
consumer-owned input, textarea, or `Select` through its render callback, so it
can connect visible labels, descriptions, required state, and announced errors
without cloning a framework-specific control.

`Dialog` and `Sheet` expose owned compound APIs (`Root`, `Trigger`, `Content`,
and `Close`; `Sheet` also provides `Body` and `Footer`). Both require an
available `PortalProvider` target, isolate the background with native inert
state, contain and restore focus, lock document scrolling, and become
full-screen at compact widths. Titles are always visible and required, while
motion is governed by the central theme tokens.

## Provenance and collaborators

The first product patterns keep source, freshness, and human responsibility as
separate contracts. `ServiceMark` names CodeCommit, CodePipeline, Jira,
Confluence, or Clockify with code-owned marks and provenance-only accents.
`FreshnessStamp` presents application-supplied `current`, `cached`, `stale`,
`missing`, or `unavailable` state without calculating time or thresholds.
`EvidenceStamp` composes both concepts while keeping the evidence reference
visible and wrap-safe.

```tsx
import { CollaboratorGroup, EvidenceStamp } from "@knpkv/rly/patterns"

export const ReviewEvidence = () => (
  <>
    <EvidenceStamp
      freshness="current"
      freshnessDateTime="2026-07-13T14:00:00Z"
      freshnessTime="Observed 2 minutes ago"
      reference="evidence/codecommit/PR-482/revision/17"
      service="codecommit"
    />
    <CollaboratorGroup
      approvers={[{ id: "casey", name: "Casey Singh", role: "Merge approver" }]}
      expandedCategories={[]}
      heading="Pull request collaborators"
      onCategoryExpandedChange={() => undefined}
      reviewers={[{ id: "avery", name: "Avery Diaz", role: "Code reviewer" }]}
    />
  </>
)
```

`Person` always renders a visible name and explicit role beside a decorative
avatar. An optional `avatarSrc` must already be validated and proxied by the
application; deterministic initials remain available when it is missing or
fails. `PeopleStrip` uses controlled expansion and the exact `+N people`
disclosure instead of an anonymous avatar stack. `CollaboratorGroup` exposes
author, owner, reviewer, operator, and approver lanes without inferring roles
from position.

## Release identity and verdicts

`ReleaseRelay` presents the release identity projection already derived and
persisted by the application. It accepts an opaque algorithm label, codename,
and exactly three distinct indices into rly's semantic-versioned 16-symbol SVG
catalog. It never receives a canonical release ID and performs no hashing,
modulo selection, codename generation, or migration.

```tsx
import { ReleaseRelay, Verdict } from "@knpkv/rly/patterns"

export const ReleaseDecision = () => (
  <>
    <ReleaseRelay algorithm="relay/v1" codename="Copper Orbit" size="hero" symbolIndices={[6, 3, 7]} />
    <Verdict
      reason="Every required check and approval matches the current release head."
      tone="positive"
      verdict="Ready to ship."
    />
  </>
)
```

The symbol order is persisted identity: indices `0..15` map to orbit, split,
brace, wave, gate, fork, bridge, beacon, loop, pulse, anchor, ladder, knot,
spark, stack, and compass. Reordering or replacing that map is a breaking
identity change rather than a cosmetic icon update.

`Verdict` stays deliberately large and neutral. The caller supplies its exact
wording, reason, and semantic tone; tone affects only the redundant icon,
4px rail, and restrained reason context. Rly does not infer readiness from any
of those values.

## Delivery stages and relationships

`StageRail` presents an application-supplied ordered stage list. Every stage
keeps its visible name and state, with an optional reason and named owner. Empty
and single-stage executions remain explicit, and the rail reflows vertically at
compact widths instead of hiding stages in a horizontal scroller.

`RelationshipChain` and `RelationshipTable` consume the same readonly
relationship records. The chain is the glanceable visual sentence; the table is
the equivalent native semantic ledger. Both preserve source, target, kind,
direction, lifecycle, evidence, and people in the same record order.

```tsx
import { RelationshipChain, RelationshipTable, StageRail, type RlyRelationship } from "@knpkv/rly/patterns"

const relationships = [
  {
    id: "jira-rps-6307-pr-291",
    kind: "Implemented by",
    direction: "forward",
    lifecycle: "verified",
    source: {
      state: "present",
      id: "jira-rps-6307",
      title: "RPS-6307",
      reference: "Release candidate",
      service: "jira",
      href: "/jira/RPS-6307"
    },
    target: {
      state: "present",
      id: "pr-291",
      title: "PR #291",
      reference: "7f4c9b1",
      service: "codecommit",
      href: "/codecommit/pulls/291"
    },
    evidence: "Head and issue link verified"
  }
] satisfies ReadonlyArray<RlyRelationship>

export const DeliveryEvidence = () => (
  <>
    <StageRail heading="Pipeline stages" stages={[{ id: "build", name: "Build", state: "Passed", tone: "positive" }]} />
    <RelationshipChain heading="Delivery relationships" relationships={relationships} />
    <RelationshipTable heading="Delivery relationship ledger" relationships={relationships} />
  </>
)
```

A missing endpoint is a real discriminated record with a visible label and
reason; it is never represented by an unexplained gap. Rly maps the seven
persisted lifecycle values—missing, inferred, proposed, verified, governed,
rejected, and superseded—to redundant icon-and-word presentation only. It does
not infer links, confidence, readiness, or authorization.

## Release dossiers and entity views

`ReleaseRow` is the bird's-eye release dossier: one unique relay, one large
caller-supplied verdict, explicit assigned or unassigned ownership, visible
facts, and controlled preview and agent actions. `ReleasePreview` opens that
projection in a caller-selected wide dialog or compact full-screen sheet before
the application routes to a full view. Its ordered slots keep the optional
complete collaborator list, primary action, stages, workset, evidence, and
contextual agent entry explicit. Primary owner and approver roles stay compact;
the collaborator slot can carry every assignment without truncating cardinality.
The application owns responsive selection through the `presentation` prop; rly
does not inspect viewport state.

`WorksetCard` keeps Jira work, CodeCommit pull-request groups, relationship
gaps, and CodePipeline executions together without flattening them into a Jira
board. It accepts arbitrary cardinality, including the six-ticket release
view, and preserves many-to-many Jira keys and missing links as data.

`EntityShell` supplies the consistent full-view frame for Jira, CodeCommit,
CodePipeline, Confluence, and Clockify pages while leaving every page body and
action application-owned. `EntityTable` provides controlled sorting and
complete ready, loading, empty, not-found, stale, partial, error, and
unavailable presentations. `TimelineRow` distinguishes human, agent, plugin,
and system actors in a semantic activity list.

```tsx
import { ReleaseRow } from "@knpkv/rly/patterns"

export const ReleaseOverview = () => (
  <ReleaseRow
    onPreview={() => openPreview()}
    release={releasePresentation}
    agentEntry={<button onClick={() => openReleaseAgent()}>Ask release agent</button>}
  />
)
```

Rly does not fetch service data, derive release readiness, execute actions, or
route between entities. Applications normalize those concerns before passing
presentation projections and controlled callbacks into these patterns.

## Contextual agents and governed actions

`AgentContextButton` is an explicit, page-level launcher whose visible label
names both the agent and its exact release or entity context. `AgentDrawer`
opens a controlled sheet in a fixed order: context, evidence, capabilities,
thread, then composer. Initial focus lands on the context summary, live updates
do not steal focus, and closing restores the launcher.

`AgentThread` presents immutable human, agent, and system messages after the
exact context and before the required composer. Human identities remain
circular; agents use a rounded square and the reserved agent color.
`AgentJob` presents caller-owned provider, capability, progress, revision or
sandbox, evidence, cancellation, and truthful terminal outcomes without
starting or cancelling work itself.

`AgentProposal` states the core boundary directly: an agent proposal is not
human authorization. `GovernedActionReview` repeats the exact capability,
target, expected revision, impact, and evidence beside a named human reviewer.
Its owned authorization button stays disabled until the controlled exact-action
confirmation is checked, and terminal outcomes remain visible after review.

```tsx
import { AgentContextButton, GovernedActionReview } from "@knpkv/rly/patterns"

export const ReleaseAgentEntry = () => (
  <AgentContextButton
    agentName="Release Guardian"
    context="Release v2.4.0 · Copper Orbit"
    onClick={() => setAgentOpen(true)}
  />
)
```

Callbacks request application-owned state changes only. Rly never contacts an
agent provider, invokes a vendor capability, derives permission, or treats an
agent proposal as a human decision.

## Complete pull-request diffs

The experimental `@knpkv/rly/diff` entry keeps the heavy renderer and its
worker graph out of ordinary primitives and patterns. `DiffWorkbench` composes
a controlled header, complete lightweight file inventory, renderer slot, and
semantic finding list. Exceptional files stay visible as loading, binary,
generated, oversized, unavailable, or error rows; renames preserve both paths.

`DiffCodeView` is the single pinned `@pierre/diffs` adapter. It accepts complete
before/after text, split or stacked layout, wrapping, context, selection,
annotations, and virtualization controls. Its imperative handle adds or
versions items and scrolls to files or lines without resetting the viewer.

```tsx
import { DiffCodeView, DiffWorkerProvider } from "@knpkv/rly/diff"

export const PullRequestDiff = () => (
  <DiffWorkerProvider poolSize={2}>
    <DiffCodeView
      initialItems={[
        {
          id: "release-gate",
          before: { name: "src/gate.ts", contents: "export const ready = false\n" },
          after: { name: "src/gate.ts", contents: "export const ready = true\n" }
        }
      ]}
      mode="split"
    />
  </DiffWorkerProvider>
)
```

The provider owns a bounded module-worker pool. If creation or execution fails,
the same complete `CodeView` remounts synchronously and announces the fallback;
it never replaces the diff with partial raw text. Applications still own
pagination, content fetching, immutable revision identity, URL state, and all
review or approval commands.

## Agent registry and scaffolding

Rly publishes four static registry artifacts for component discovery and
planning: `components.json`, its strict `schema.json`, a compact `search.json`,
and `USAGE.md`. Import them through the explicit
`@knpkv/rly/registry/*` package exports. They contain metadata only—never
component implementations, callbacks, actions, or a JSON-to-React runtime.

Validate the generated registry and scaffold a complete maintainer-owned
component slice with:

```bash
pnpm --filter @knpkv/rly validate:registry
pnpm --filter @knpkv/rly scaffold -- primitive SignalCard "Present one explicit delivery signal state"
```

The scaffolder validates every target before writing, then creates the source,
focused CSS, all-state Storybook story, DOM/accessibility test, manifest entry,
registry metadata, generated exports, and public index together. Applications
continue to compile typed React presenters and keep all service and agent
execution outside rly.

## Component catalog

Storybook is the bounded development and review surface for `rly`. It binds to
localhost, does not open a browser, and exposes toolbar controls for theme,
forced colors, reduced motion, viewport, locale, and density.

```bash
pnpm --filter @knpkv/rly storybook
pnpm --filter @knpkv/rly storybook:build
```

`storybook:build` also validates that the static catalog contains both the
interactive story and its generated documentation route.

The workspace docs build publishes the same static catalog at
`/rly/catalog/`, beside the indexed install, export, token, theme, registry,
and usage documentation.

Browser checks are deliberately serialized to one Chromium worker. Install the
managed browser once, then run the complete catalog gate:

```bash
pnpm --filter @knpkv/rly exec playwright install chromium
pnpm --filter @knpkv/rly test:browser
```

The gate runs Storybook interaction and accessibility tests, builds the static
catalog, exercises its global presentation states, and verifies clean server
and browser teardown.

## Visual change classification

The generated visual catalog maps every public component to its stories and
tests. CI tooling can classify a Git range without shell interpolation:

```bash
pnpm --filter @knpkv/rly visual:classify --base origin/main --head HEAD
```

The command emits deterministic JSON. Missing refs, malformed Git output,
unknown paths, catalog drift, or changes to foundations and shared visual
configuration fail closed to a full visual run.
