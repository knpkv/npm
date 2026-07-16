import type { RegistryMetadata } from "../component-manifest.js"

const COMMON_ACCESSIBILITY: readonly [string, ...ReadonlyArray<string>] = [
  "Provide a programmatic name for interactive or informative content",
  "Preserve keyboard access, focus visibility, and color-independent meaning"
]

const registryMetadata = (
  purpose: string,
  states: readonly [string, ...ReadonlyArray<string>] = ["default"],
  capabilities: readonly [string, ...ReadonlyArray<string>] = ["present"]
): RegistryMetadata => ({ accessibility: COMMON_ACCESSIBILITY, capabilities, purpose, states })

/** Curated, fail-closed guidance keyed one-to-one with registry component names. */
export const COMPONENT_REGISTRY_METADATA = {
  // scaffold:registry-metadata:insert
  AgentContextButton: registryMetadata("Open an agent in the exact current entity or release context", [
    "complete"
  ], ["agent", "open"]),
  AgentDrawer: registryMetadata("Host release-aware agent context, thread, jobs, and proposals", ["open"], [
    "agent",
    "overlay"
  ]),
  AgentJob: registryMetadata("Present cancellable agent progress and terminal outcomes", [
    "cancelled",
    "failed",
    "queued",
    "running",
    "succeeded"
  ], ["agent", "progress"]),
  AgentProposal: registryMetadata("Distinguish an agent proposal from human authorization", [
    "proposed",
    "superseded"
  ], ["agent", "propose"]),
  AgentThread: registryMetadata("Present an isolated human, agent, and system conversation", [
    "active",
    "held"
  ], ["agent", "conversation"]),
  Avatar: registryMetadata("Show a person or agent image with a deterministic accessible fallback", [
    "circle",
    "fallback",
    "hero",
    "large",
    "rounded-square",
    "small"
  ], ["identify"]),
  Button: registryMetadata("Offer a visible-text action with stable loading and disabled geometry", [
    "compact",
    "disabled",
    "loading",
    "primary",
    "principal",
    "quiet",
    "secondary"
  ], ["act"]),
  CollaboratorGroup: registryMetadata("Group named collaborators by explicit lifecycle role", [
    "compact",
    "empty"
  ], ["group", "people"]),
  Dialog: registryMetadata("Present a modal task with contained focus and deterministic dismissal", [
    "nested",
    "open"
  ], ["confirm", "overlay"]),
  DiffCodeView: registryMetadata("Render a complete, virtualized before-and-after code review", [
    "stacked",
    "strict"
  ], ["compare", "review"]),
  DiffFileTree: registryMetadata("Navigate the complete file inventory of a code change", [
    "added",
    "binary",
    "deleted",
    "modified",
    "renamed",
    "unavailable"
  ], ["filter", "navigate"]),
  DiffFinding: registryMetadata("Present an anchored human or agent code-review finding", [
    "agent",
    "current",
    "human",
    "resolved",
    "stale"
  ], ["annotate", "review"]),
  DiffHeader: registryMetadata("Control diff layout, wrapping, context, and finding filters", [
    "agent",
    "all",
    "split",
    "stacked",
    "wrapped"
  ], ["configure", "filter"]),
  DiffWorkbench: registryMetadata("Compose file navigation, code rendering, and findings into one review workspace", [
    "all-files",
    "selected-file"
  ], ["compare", "navigate", "review"]),
  DiffWorkerProvider: registryMetadata("Bound and provide syntax-highlighting workers with a synchronous fallback", [
    "fallback",
    "worker"
  ], ["render", "virtualize"]),
  Divider: registryMetadata("Separate adjacent content without encoding domain state", [
    "horizontal",
    "strong",
    "subtle",
    "vertical"
  ], ["separate"]),
  EntityShell: registryMetadata("Compose a service entity hero, facts, collaborators, and actions", [
    "error",
    "stale"
  ], ["compose", "entity"]),
  EntityTable: registryMetadata("Present sortable entity data with responsive row semantics", [
    "empty",
    "error",
    "loading",
    "ready"
  ], ["sort", "table"]),
  EvidenceStamp: registryMetadata("Identify immutable source evidence and its capture time", [
    "current",
    "missing",
    "stale"
  ], ["evidence"]),
  Field: registryMetadata("Pair a form control with its label, description, and announced error", [
    "compact"
  ], ["input"]),
  FreshnessStamp: registryMetadata(
    "Expose whether displayed evidence is current, cached, stale, missing, or unavailable",
    ["cached", "compact", "current", "missing", "stale", "unavailable"],
    ["freshness", "status"]
  ),
  GlobalStyles: registryMetadata("Install rly reset, token, typography, and theme style layers", ["scope"], [
    "style",
    "theme"
  ]),
  GovernedActionReview: registryMetadata("Require explicit human review of target, revision, impact, and evidence", [
    "complete",
    "failed",
    "review"
  ], ["confirm", "govern"]),
  Icon: registryMetadata("Render a named, size-controlled icon with explicit decorative semantics", [
    "decorative",
    "large",
    "small"
  ], ["symbol"]),
  IconButton: registryMetadata("Offer a labelled icon-only action with stable loading geometry", [
    "compact",
    "disabled",
    "loading",
    "primary",
    "principal",
    "quiet",
    "secondary"
  ], ["act"]),
  LinkProvider: registryMetadata("Bridge rly links to an application router without coupling packages", [
    "framework-bridge"
  ], ["navigate"]),
  PeopleStrip: registryMetadata("Show a compact named collaborator list with explicit overflow", [
    "compact",
    "overflow"
  ], ["people"]),
  Person: registryMetadata("Show one named human and their explicit role", [
    "compact",
    "fallback"
  ], ["identify", "people"]),
  PortalProvider: registryMetadata("Choose the controlled portal target used by rly overlays", [
    "custom-target"
  ], ["overlay"]),
  RelationshipChain: registryMetadata("Show arbitrary-cardinality delivery relationships as a semantic chain", [
    "complete",
    "inferred",
    "missing"
  ], ["relationship", "trace"]),
  RelationshipTable: registryMetadata("Provide the table-equivalent view of delivery relationships", [
    "complete",
    "inferred",
    "missing"
  ], ["relationship", "table"]),
  ReleasePreview: registryMetadata("Preview release identity, verdict, work, and actions before full navigation", [
    "dialog",
    "ready",
    "sheet",
    "unknown"
  ], ["inspect", "release"]),
  ReleaseRelay: registryMetadata("Render the caller-derived stable release codename and three-symbol identity", [
    "compact",
    "forced-colors",
    "hero"
  ], ["identify", "release"]),
  ReleaseRow: registryMetadata("Summarize a release for compact portfolio navigation", [
    "building",
    "blocked",
    "deploying",
    "ready",
    "held",
    "shipped",
    "unknown"
  ], ["navigate", "release"]),
  Select: registryMetadata("Choose one controlled option with complete label and error semantics", [
    "compact",
    "disabled"
  ], ["select"]),
  SemanticTokens: registryMetadata("Discover the semantic color, type, spacing, shape, and motion contract", [
    "overview"
  ], ["style", "theme"]),
  ServiceMark: registryMetadata("Identify CodeCommit, CodePipeline, Jira, Confluence, or Clockify by name and mark", [
    "clockify",
    "codecommit",
    "codepipeline",
    "compact",
    "confluence",
    "jira"
  ], ["identify", "service"]),
  Sheet: registryMetadata("Present a side-mounted modal task with structured body and footer slots", [
    "end",
    "open",
    "start"
  ], ["inspect", "overlay"]),
  Skeleton: registryMetadata("Reserve content geometry while data is loading", ["block", "circle", "text"], [
    "loading"
  ]),
  StageRail: registryMetadata("Summarize progress across controlled delivery stages", [
    "blocked",
    "building",
    "compact",
    "complete"
  ], ["delivery", "progress"]),
  StateLabel: registryMetadata("Name a compact state using text and color-independent tone", [
    "caution",
    "compact",
    "critical",
    "neutral",
    "positive",
    "progress"
  ], ["status"]),
  StatePanel: registryMetadata("Explain loading, empty, error, or recovery states with an optional action", [
    "caution",
    "critical",
    "neutral",
    "positive",
    "progress"
  ], ["recover", "status"]),
  Surface: registryMetadata("Group related content on a semantic themed surface", [
    "card",
    "compact",
    "grouped",
    "none",
    "primary",
    "secondary",
    "spacious",
    "tertiary"
  ], ["group"]),
  Tabs: registryMetadata("Switch controlled views using roving keyboard focus", ["disabled", "large", "selected"], [
    "navigate",
    "select"
  ]),
  Text: registryMetadata("Apply the rly type hierarchy and semantic text tones", [
    "body",
    "body-large",
    "card-title",
    "code",
    "inherit",
    "label",
    "meta",
    "page-title",
    "primary",
    "secondary",
    "section-title",
    "tertiary",
    "verdict"
  ], ["typography"]),
  ThemeProvider: registryMetadata("Control the light, dark, or system rly theme", ["dark", "light", "system"], [
    "theme"
  ]),
  TimelineRow: registryMetadata("Present one attributable human, agent, system, or service event", [
    "agent",
    "human",
    "service",
    "system"
  ], ["audit", "timeline"]),
  Verdict: registryMetadata("State a release verdict with text, icon, and color-independent tone", [
    "caution",
    "critical",
    "neutral",
    "positive",
    "progress"
  ], ["release", "status"]),
  WorksetCard: registryMetadata("Show Jira items together with pull-request and pipeline dimensions", [
    "complete",
    "gap"
  ], ["relationship", "release"])
} satisfies Readonly<Record<string, RegistryMetadata>>
