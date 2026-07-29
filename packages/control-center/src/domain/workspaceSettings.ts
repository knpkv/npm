import * as Schema from "effect/Schema"

const boundedInteger = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }))

const AgentProviderIdentifier = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/u, {
    expected: "a lowercase agent provider identifier"
  })
)

const AgentModelIdentifier = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u, {
    expected: "a bounded agent model identifier"
  })
)

const canonicalText = Schema.makeFilter(
  (values: ReadonlyArray<string>) => values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value),
  { expected: "values in canonical ascending order" }
)

/** Every independently editable section in the workspace settings document. */
export const WorkspaceSettingsSection = Schema.Literals([
  "agent",
  "inference",
  "investigation",
  "jira",
  "pipeline",
  "presentation",
  "retention",
  "synchronization"
])

/** Decoded workspace-settings section name. */
export type WorkspaceSettingsSection = typeof WorkspaceSettingsSection.Type

/** Canonical set of changed settings sections retained by one immutable audit. */
export const WorkspaceSettingsSections = Schema.Array(WorkspaceSettingsSection).check(
  Schema.isUnique(),
  canonicalText,
  Schema.makeFilter((sections) => sections.length <= 8, {
    expected: "at most eight workspace settings sections"
  })
)

/** Decoded canonical changed-section set. */
export type WorkspaceSettingsSections = typeof WorkspaceSettingsSections.Type

/** Sections whose changes alter authorization, provider-write, or retention policy. */
export const GovernedWorkspaceSettingsSection = Schema.Literals([
  "agent",
  "jira",
  "pipeline",
  "retention"
])

/** Decoded governed workspace-settings section name. */
export type GovernedWorkspaceSettingsSection = typeof GovernedWorkspaceSettingsSection.Type

/** Canonical exact set of governed sections acknowledged by one mutation. */
export const GovernedWorkspaceSettingsSections = Schema.Array(
  GovernedWorkspaceSettingsSection
).check(
  Schema.isUnique(),
  canonicalText,
  Schema.makeFilter((sections) => sections.length <= 4, {
    expected: "at most four governed settings sections"
  })
)

/** Decoded canonical governed-section acknowledgement. */
export type GovernedWorkspaceSettingsSections = typeof GovernedWorkspaceSettingsSections.Type

/** Version-one server-owned workspace settings. */
export const WorkspaceSettingsV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  inference: Schema.Struct({
    enabled: Schema.Boolean,
    minimumConfidencePercent: boundedInteger(0, 100)
  }),
  synchronization: Schema.Struct({
    cadence: Schema.Literals(["manual", "interval"]),
    intervalMinutes: Schema.NullOr(boundedInteger(5, 10_080)),
    staleAfterMinutes: boundedInteger(5, 43_200)
  }).check(
    Schema.makeFilter(
      ({ cadence, intervalMinutes }) => cadence === "manual" ? intervalMinutes === null : intervalMinutes !== null,
      { expected: "an interval only for interval synchronization" }
    )
  ),
  retention: Schema.Struct({
    evidenceDays: boundedInteger(1, 3_650),
    contentDays: boundedInteger(1, 3_650),
    auditDays: boundedInteger(1, 3_650),
    agentActivityDays: boundedInteger(1, 365),
    sandboxArtifactDays: boundedInteger(1, 30)
  }).check(
    Schema.makeFilter(
      ({ auditDays, evidenceDays }) => auditDays >= evidenceDays,
      { expected: "audit retention not shorter than evidence retention" }
    ),
    Schema.makeFilter(
      ({ agentActivityDays, sandboxArtifactDays }) => agentActivityDays >= sandboxArtifactDays,
      { expected: "agent activity retention not shorter than sandbox artifact retention" }
    )
  ),
  investigation: Schema.Struct({
    mode: Schema.Literals(["manual", "automatic"]),
    consecutiveFailureThreshold: boundedInteger(1, 20)
  }),
  jira: Schema.Struct({
    commentMode: Schema.Literals(["manual-only", "confirm-before-publish"]),
    includeControlCenterAttribution: Schema.Boolean
  }),
  pipeline: Schema.Struct({
    retryMode: Schema.Literals(["manual-only", "confirm-before-retry"]),
    maximumAttempts: boundedInteger(1, 10)
  }),
  agent: Schema.Struct({
    allowedProviders: Schema.Array(AgentProviderIdentifier).check(
      Schema.isUnique(),
      canonicalText,
      Schema.makeFilter((providers) => providers.length <= 16, {
        expected: "at most sixteen allowed agent providers"
      })
    ),
    defaultProvider: Schema.NullOr(AgentProviderIdentifier),
    defaultModel: Schema.NullOr(AgentModelIdentifier),
    toolPolicy: Schema.Literals(["read-only", "review-sandbox"]),
    profilePolicy: Schema.Literals(["isolated", "local-profile"])
  }).check(
    Schema.makeFilter(
      ({ allowedProviders, defaultProvider }) => defaultProvider === null || allowedProviders.includes(defaultProvider),
      { expected: "the default agent provider to be allowed" }
    ),
    Schema.makeFilter(
      ({ defaultModel, defaultProvider }) => defaultModel === null || defaultProvider !== null,
      { expected: "a default provider when a default model is configured" }
    )
  ),
  presentation: Schema.Struct({
    density: Schema.Literals(["comfortable", "compact"]),
    defaultLanding: Schema.Literals(["overview", "active-work"])
  })
}).annotate({ identifier: "WorkspaceSettingsV1" })

/** Decoded version-one workspace settings. */
export type WorkspaceSettingsV1 = typeof WorkspaceSettingsV1.Type

/** Canonical defaults installed for every existing or newly created workspace. */
export const DEFAULT_WORKSPACE_SETTINGS = WorkspaceSettingsV1.make({
  schemaVersion: 1,
  inference: {
    enabled: true,
    minimumConfidencePercent: 80
  },
  synchronization: {
    cadence: "manual",
    intervalMinutes: null,
    staleAfterMinutes: 1_440
  },
  retention: {
    evidenceDays: 365,
    contentDays: 90,
    auditDays: 365,
    agentActivityDays: 30,
    sandboxArtifactDays: 7
  },
  investigation: {
    mode: "manual",
    consecutiveFailureThreshold: 3
  },
  jira: {
    commentMode: "manual-only",
    includeControlCenterAttribution: true
  },
  pipeline: {
    retryMode: "manual-only",
    maximumAttempts: 1
  },
  agent: {
    allowedProviders: [],
    defaultProvider: null,
    defaultModel: null,
    toolPolicy: "read-only",
    profilePolicy: "isolated"
  },
  presentation: {
    density: "comfortable",
    defaultLanding: "overview"
  }
})

const agentSettingsEqual = Schema.toEquivalence(WorkspaceSettingsV1.fields.agent)
const inferenceSettingsEqual = Schema.toEquivalence(WorkspaceSettingsV1.fields.inference)
const investigationSettingsEqual = Schema.toEquivalence(WorkspaceSettingsV1.fields.investigation)
const jiraSettingsEqual = Schema.toEquivalence(WorkspaceSettingsV1.fields.jira)
const pipelineSettingsEqual = Schema.toEquivalence(WorkspaceSettingsV1.fields.pipeline)
const presentationSettingsEqual = Schema.toEquivalence(WorkspaceSettingsV1.fields.presentation)
const retentionSettingsEqual = Schema.toEquivalence(WorkspaceSettingsV1.fields.retention)
const synchronizationSettingsEqual = Schema.toEquivalence(WorkspaceSettingsV1.fields.synchronization)

const orderedSections: ReadonlyArray<WorkspaceSettingsSection> = [
  "agent",
  "inference",
  "investigation",
  "jira",
  "pipeline",
  "presentation",
  "retention",
  "synchronization"
]

const workspaceSettingsSectionChanged = (
  section: WorkspaceSettingsSection,
  current: WorkspaceSettingsV1,
  candidate: WorkspaceSettingsV1
): boolean => {
  switch (section) {
    case "agent":
      return !agentSettingsEqual(current.agent, candidate.agent)
    case "inference":
      return !inferenceSettingsEqual(current.inference, candidate.inference)
    case "investigation":
      return !investigationSettingsEqual(current.investigation, candidate.investigation)
    case "jira":
      return !jiraSettingsEqual(current.jira, candidate.jira)
    case "pipeline":
      return !pipelineSettingsEqual(current.pipeline, candidate.pipeline)
    case "presentation":
      return !presentationSettingsEqual(current.presentation, candidate.presentation)
    case "retention":
      return !retentionSettingsEqual(current.retention, candidate.retention)
    case "synchronization":
      return !synchronizationSettingsEqual(current.synchronization, candidate.synchronization)
  }
}

/** Determine the canonical set of sections changed by a complete settings replacement. */
export const changedWorkspaceSettingsSections = (
  current: WorkspaceSettingsV1,
  candidate: WorkspaceSettingsV1
): ReadonlyArray<WorkspaceSettingsSection> =>
  orderedSections.filter((section) => workspaceSettingsSectionChanged(section, current, candidate))

/** Narrow one settings section to the subset that requires governed acknowledgement. */
export const isGovernedWorkspaceSettingsSection = (
  section: WorkspaceSettingsSection
): section is GovernedWorkspaceSettingsSection =>
  section === "agent" || section === "jira" || section === "pipeline" || section === "retention"
