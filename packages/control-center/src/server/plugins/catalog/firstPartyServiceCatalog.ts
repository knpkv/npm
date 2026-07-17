import {
  PluginConfigurationKey,
  type PluginServiceCatalogEntry,
  type PluginServiceCatalogField
} from "../../../api/plugins.js"
import type { ProviderId } from "../../../domain/sourceRevision.js"
import { clockifyReadPluginDescriptor } from "../clockify/ClockifyReadPlugin.js"
import { codeCommitPluginDefinition } from "../codecommit/CodeCommitPluginDefinition.js"
import { codePipelinePluginDefinition } from "../codepipeline/CodePipelinePluginDefinition.js"
import { confluencePagePluginDescriptor } from "../confluence/ConfluencePagePluginDefinition.js"
import { jiraReadPluginDescriptor } from "../jira/JiraReadPlugin.js"

interface FirstPartyServiceCatalogEntry {
  readonly metadata: PluginServiceCatalogEntry
  readonly rawDescriptor: unknown
}

const field = (
  key: string,
  label: string,
  description: string,
  kind: PluginServiceCatalogField["kind"],
  options: {
    readonly defaultValue?: string
    readonly isReadOnly?: boolean
    readonly scope?: PluginServiceCatalogField["scope"]
    readonly minimum?: number
    readonly maximum?: number
  } = {}
): PluginServiceCatalogField => ({
  key: PluginConfigurationKey.make(key),
  label,
  description,
  kind,
  scope: options.scope ?? "adapter",
  required: true,
  defaultValue: options.defaultValue ?? null,
  isReadOnly: options.isReadOnly ?? false,
  minimum: options.minimum ?? null,
  maximum: options.maximum ?? null
})

const codeCommitFields = [
  field("profile", "AWS profile", "Local AWS profile used by the server.", "text", { defaultValue: "default" }),
  field("region", "AWS region", "Region containing the CodeCommit repository.", "text"),
  field("repositoryName", "Repository", "CodeCommit repository to read.", "text")
]
const codePipelineFields = [
  field("profile", "AWS profile", "Local AWS profile used by the server.", "text", { defaultValue: "default" }),
  field("region", "AWS region", "Region containing the CodePipeline pipeline.", "text"),
  field("pipelineName", "Pipeline", "CodePipeline pipeline to read.", "text"),
  field("maximumExecutionPages", "Execution pages", "Maximum execution pages per synchronization.", "integer", {
    defaultValue: "5",
    minimum: 1,
    maximum: 20
  }),
  field("actionPageSize", "Action page size", "Action executions requested per provider page.", "integer", {
    defaultValue: "50",
    minimum: 1,
    maximum: 100
  }),
  field("maximumActionPages", "Action pages", "Maximum action pages per execution.", "integer", {
    defaultValue: "3",
    minimum: 1,
    maximum: 5
  }),
  field("maximumActionsPerExecution", "Actions per execution", "Maximum normalized actions per execution.", "integer", {
    defaultValue: "100",
    minimum: 1,
    maximum: 200
  }),
  field("operationTimeoutMillis", "Request timeout", "Provider request timeout in milliseconds.", "integer", {
    defaultValue: "30000",
    minimum: 1_000,
    maximum: 120_000
  })
]
const jiraFields = [
  field("webBaseUrl", "Jira site URL", "Root URL of the Jira Cloud site.", "url"),
  field("email", "Atlassian email", "Email paired with the Jira API token.", "text", { scope: "credential" }),
  field("apiToken", "API token", "Atlassian API token stored only in the server secret store.", "secret", {
    scope: "credential"
  }),
  field("pageSize", "Activity page size", "Comments and history entries requested per page.", "integer", {
    defaultValue: "50",
    minimum: 1,
    maximum: 50
  }),
  field("maximumPages", "Maximum activity pages", "Maximum comments and history pages per request.", "integer", {
    defaultValue: "5",
    minimum: 1,
    maximum: 5
  }),
  field("operationTimeoutMillis", "Request timeout", "Provider request timeout in milliseconds.", "integer", {
    defaultValue: "30000",
    minimum: 1_000,
    maximum: 120_000
  })
]
const confluenceFields = [
  field("siteBaseUrl", "Confluence site URL", "Root URL of the Confluence Cloud site.", "url"),
  field("email", "Atlassian email", "Email paired with the Confluence API token.", "text", { scope: "credential" }),
  field("apiToken", "API token", "Atlassian API token stored only in the server secret store.", "secret", {
    scope: "credential"
  }),
  field("siteId", "Site ID", "Stable Atlassian site identity.", "text"),
  field("spaceId", "Space ID", "Confluence space visible through this connection.", "text"),
  field("probePageId", "Health page ID", "Readable page used for the initial health check.", "text")
]
const clockifyFields = [
  field("apiKey", "API key", "Clockify API key stored only in the server secret store.", "secret", {
    scope: "credential"
  }),
  field("webBaseUrl", "Clockify site URL", "Fixed browser-facing Clockify origin.", "url", {
    defaultValue: "https://app.clockify.me/",
    isReadOnly: true
  }),
  field("workspaceId", "Workspace ID", "Clockify workspace to read.", "text"),
  field("userIds", "User IDs", "Comma-separated Clockify user IDs included in synchronization.", "text"),
  field("pageSize", "Time-entry page size", "Entries requested for each user per page.", "integer", {
    defaultValue: "50",
    minimum: 1,
    maximum: 50
  }),
  field("maximumPages", "Maximum pages", "Maximum time-entry pages per user.", "integer", {
    defaultValue: "10",
    minimum: 1,
    maximum: 10
  }),
  field("maximumConcurrency", "Maximum concurrency", "Maximum simultaneous Clockify reads.", "integer", {
    defaultValue: "3",
    minimum: 1,
    maximum: 5
  }),
  field("operationTimeoutMillis", "Request timeout", "Provider request timeout in milliseconds.", "integer", {
    defaultValue: "30000",
    minimum: 1_000,
    maximum: 120_000
  })
]

const entry = (
  providerId: ProviderId,
  displayName: string,
  description: string,
  configurationFields: ReadonlyArray<PluginServiceCatalogField>,
  rawDescriptor: unknown
): FirstPartyServiceCatalogEntry => ({
  metadata: { providerId, displayName, description, configurationFields },
  rawDescriptor
})

/** Fixed server-owned catalog paired with each runtime's canonical descriptor. */
export const firstPartyServiceCatalog: ReadonlyArray<FirstPartyServiceCatalogEntry> = [
  entry(
    "codecommit",
    "CodeCommit",
    "Read pull requests from one AWS CodeCommit repository.",
    codeCommitFields,
    codeCommitPluginDefinition.rawDescriptor
  ),
  entry(
    "codepipeline",
    "CodePipeline",
    "Read pipeline and execution state from AWS CodePipeline.",
    codePipelineFields,
    codePipelinePluginDefinition.rawDescriptor
  ),
  entry("jira", "Jira", "Read delivery issues from Jira Cloud.", jiraFields, jiraReadPluginDescriptor),
  entry(
    "confluence",
    "Confluence",
    "Read release documentation from Confluence Cloud.",
    confluenceFields,
    confluencePagePluginDescriptor
  ),
  entry(
    "clockify",
    "Clockify",
    "Read bounded time-entry evidence from Clockify.",
    clockifyFields,
    clockifyReadPluginDescriptor
  )
]

/** Resolve one server-owned catalog entry by its stable provider identity. */
export const firstPartyService = (providerId: ProviderId): FirstPartyServiceCatalogEntry | undefined =>
  firstPartyServiceCatalog.find((candidate) => candidate.metadata.providerId === providerId)
