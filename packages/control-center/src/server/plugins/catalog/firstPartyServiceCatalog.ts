import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import {
  type CreatePluginConnectionValue,
  PluginConfigurationKey,
  type PluginServiceCatalogEntry,
  type PluginServiceCatalogField
} from "../../../api/plugins.js"
import {
  type FirstPartyServiceIdentity,
  firstPartyServiceIdentityByProvider
} from "../../../domain/firstPartyServices.js"
import type { ProviderId } from "../../../domain/sourceRevision.js"
import { AtlassianBasicAuthEmail } from "../AtlassianBasicAuth.js"
import { ClockifyReadPluginConfiguration, clockifyReadPluginDescriptor } from "../clockify/ClockifyReadPlugin.js"
import { CodeCommitPluginConfiguration, codeCommitPluginDefinition } from "../codecommit/CodeCommitPluginDefinition.js"
import {
  CodePipelinePluginConfiguration,
  codePipelinePluginDefinition
} from "../codepipeline/CodePipelinePluginDefinition.js"
import { ConfluencePageAdapterConfiguration } from "../confluence/ConfluencePageAdapter.js"
import { confluencePagePluginDescriptor } from "../confluence/ConfluencePagePluginDefinition.js"
import { JiraReadPluginConfiguration, jiraReadPluginDescriptor } from "../jira/JiraReadPlugin.js"

interface FirstPartyServiceCatalogEntry {
  readonly metadata: PluginServiceCatalogEntry
  readonly rawDescriptor: unknown
  readonly validatesSetup: (values: ReadonlyArray<CreatePluginConnectionValue>) => boolean
}

const setupValues = (values: ReadonlyArray<CreatePluginConnectionValue>): ReadonlyMap<string, string | number> =>
  new Map(values.map((value) => [value.key, value.value]))

const atlassianAuthenticationIsValid = (configured: ReadonlyMap<string, string | number>): boolean => {
  const authMode = configured.get("authMode")
  if (authMode === "oauth") {
    const profileId = configured.get("oauthProfileId")
    return typeof profileId === "string" && profileId.length > 0
  }
  const apiToken = configured.get("apiToken")
  return authMode === "api-token" &&
    Schema.is(AtlassianBasicAuthEmail)(configured.get("email")) &&
    typeof apiToken === "string" &&
    apiToken.length > 0
}

const jiraSetupIsValid = (values: ReadonlyArray<CreatePluginConnectionValue>): boolean => {
  const configured = setupValues(values)
  return Result.isSuccess(
    Schema.decodeUnknownResult(JiraReadPluginConfiguration)({
      webBaseUrl: configured.get("webBaseUrl"),
      pageSize: configured.get("pageSize"),
      maximumPages: configured.get("maximumPages"),
      operationTimeoutMillis: configured.get("operationTimeoutMillis")
    })
  ) && atlassianAuthenticationIsValid(configured)
}

const confluenceSetupIsValid = (values: ReadonlyArray<CreatePluginConnectionValue>): boolean => {
  const configured = setupValues(values)
  return Result.isSuccess(
    Schema.decodeUnknownResult(ConfluencePageAdapterConfiguration)({
      siteBaseUrl: configured.get("siteBaseUrl"),
      siteId: configured.get("siteId"),
      spaceId: configured.get("spaceId"),
      probePageId: configured.get("probePageId")
    })
  ) && atlassianAuthenticationIsValid(configured)
}

const clockifySetupIsValid = (values: ReadonlyArray<CreatePluginConnectionValue>): boolean => {
  const configured = setupValues(values)
  return Result.isSuccess(
    Schema.decodeUnknownResult(ClockifyReadPluginConfiguration)({
      webBaseUrl: configured.get("webBaseUrl"),
      workspaceId: configured.get("workspaceId"),
      userIds: configured.get("userIds"),
      pageSize: configured.get("pageSize"),
      maximumPages: configured.get("maximumPages"),
      maximumConcurrency: configured.get("maximumConcurrency"),
      operationTimeoutMillis: configured.get("operationTimeoutMillis")
    })
  )
}

const codeCommitSetupIsValid = (values: ReadonlyArray<CreatePluginConnectionValue>): boolean => {
  const configured = setupValues(values)
  return Result.isSuccess(
    Schema.decodeUnknownResult(CodeCommitPluginConfiguration)({
      profile: configured.get("profile"),
      region: configured.get("region"),
      repositoryName: configured.get("repositoryName")
    })
  )
}

const codePipelineSetupIsValid = (values: ReadonlyArray<CreatePluginConnectionValue>): boolean => {
  const configured = setupValues(values)
  return Result.isSuccess(
    Schema.decodeUnknownResult(CodePipelinePluginConfiguration)({
      profile: configured.get("profile"),
      region: configured.get("region"),
      pipelineName: configured.get("pipelineName"),
      maximumExecutionPages: configured.get("maximumExecutionPages"),
      actionPageSize: configured.get("actionPageSize"),
      maximumActionPages: configured.get("maximumActionPages"),
      maximumActionsPerExecution: configured.get("maximumActionsPerExecution"),
      operationTimeoutMillis: configured.get("operationTimeoutMillis")
    })
  )
}

const field = (
  key: string,
  label: string,
  description: string,
  kind: PluginServiceCatalogField["kind"],
  options: {
    readonly defaultValue?: string
    readonly isReadOnly?: boolean
    readonly required?: boolean
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
  required: options.required ?? true,
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
  field("authMode", "Authentication", "OAuth profile or API token fallback.", "text", {
    defaultValue: "api-token"
  }),
  field("oauthProfileId", "OAuth profile", "Shared local Atlassian OAuth profile.", "text", { required: false }),
  field("email", "Atlassian email", "Email paired with the Jira API token.", "text", {
    scope: "credential",
    required: false
  }),
  field("apiToken", "API token", "Atlassian API token stored only in the server secret store.", "secret", {
    scope: "credential",
    required: false
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
  field("authMode", "Authentication", "OAuth profile or API token fallback.", "text", {
    defaultValue: "api-token"
  }),
  field("oauthProfileId", "OAuth profile", "Shared local Atlassian OAuth profile.", "text", { required: false }),
  field("email", "Atlassian email", "Email paired with the Confluence API token.", "text", {
    scope: "credential",
    required: false
  }),
  field("apiToken", "API token", "Atlassian API token stored only in the server secret store.", "secret", {
    scope: "credential",
    required: false
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
  identity: FirstPartyServiceIdentity,
  configurationFields: ReadonlyArray<PluginServiceCatalogField>,
  rawDescriptor: unknown,
  validatesSetup: FirstPartyServiceCatalogEntry["validatesSetup"]
): FirstPartyServiceCatalogEntry => ({
  metadata: { ...identity, configurationFields },
  rawDescriptor,
  validatesSetup
})

/** Fixed server-owned catalog paired with each runtime's canonical descriptor. */
export const firstPartyServiceCatalog: ReadonlyArray<FirstPartyServiceCatalogEntry> = [
  entry(
    firstPartyServiceIdentityByProvider.codecommit,
    codeCommitFields,
    codeCommitPluginDefinition.rawDescriptor,
    codeCommitSetupIsValid
  ),
  entry(
    firstPartyServiceIdentityByProvider.codepipeline,
    codePipelineFields,
    codePipelinePluginDefinition.rawDescriptor,
    codePipelineSetupIsValid
  ),
  entry(
    firstPartyServiceIdentityByProvider.jira,
    jiraFields,
    jiraReadPluginDescriptor,
    jiraSetupIsValid
  ),
  entry(
    firstPartyServiceIdentityByProvider.confluence,
    confluenceFields,
    confluencePagePluginDescriptor,
    confluenceSetupIsValid
  ),
  entry(
    firstPartyServiceIdentityByProvider.clockify,
    clockifyFields,
    clockifyReadPluginDescriptor,
    clockifySetupIsValid
  )
]

/** Resolve one server-owned catalog entry by its stable provider identity. */
export const firstPartyService = (providerId: ProviderId): FirstPartyServiceCatalogEntry | undefined =>
  firstPartyServiceCatalog.find((candidate) => candidate.metadata.providerId === providerId)
