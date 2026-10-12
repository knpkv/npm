import type { CreatePluginConnectionRequest } from "../../src/api/plugins.js"

/** AWS profiles are fixture labels consumed only by fake credential resolution. */
export const codeCommitInput = (second: boolean) => ({
  pluginConnectionId: second ? "01890f6f-6d6a-7cc0-98d2-000000000202" : "01890f6f-6d6a-7cc0-98d2-000000000201",
  providerId: "codecommit",
  displayName: second ? "Fixture CodeCommit B" : "Fixture CodeCommit A",
  values: [
    { _tag: "text", key: "profile", value: second ? "fixture-aws-b" : "fixture-aws-a" },
    { _tag: "text", key: "region", value: "us-east-1" },
    { _tag: "text", key: "repositoryName", value: second ? "fixture-catalogue" : "fixture-checkout" }
  ]
} satisfies typeof CreatePluginConnectionRequest.Encoded)

export const pipelineInput = {
  pluginConnectionId: "01890f6f-6d6a-7cc0-98d2-000000000203",
  providerId: "codepipeline",
  displayName: "Fixture CodePipeline",
  values: [
    { _tag: "text", key: "profile", value: "fixture-aws-a" },
    { _tag: "text", key: "region", value: "us-east-1" },
    { _tag: "text", key: "pipelineName", value: "fixture-pipeline" },
    { _tag: "integer", key: "maximumExecutionPages", value: 2 },
    { _tag: "integer", key: "actionPageSize", value: 20 },
    { _tag: "integer", key: "maximumActionPages", value: 2 },
    { _tag: "integer", key: "maximumActionsPerExecution", value: 20 },
    { _tag: "integer", key: "maximumLogBytes", value: 32768 },
    { _tag: "integer", key: "operationTimeoutMillis", value: 5000 }
  ]
} satisfies typeof CreatePluginConnectionRequest.Encoded

export const confluenceInput = {
  pluginConnectionId: "01890f6f-6d6a-7cc0-98d2-000000000204",
  providerId: "confluence",
  displayName: "Fixture Confluence",
  values: [
    { _tag: "url", key: "siteBaseUrl", value: "https://fixture.atlassian.net" },
    { _tag: "text", key: "siteId", value: "fixture-site" },
    { _tag: "text", key: "spaceId", value: "40001" },
    { _tag: "text", key: "probePageId", value: "30001" },
    { _tag: "text", key: "email", value: "owner@example.com" },
    { _tag: "secret", key: "apiToken", value: "fixture-confluence-token" }
  ]
} satisfies typeof CreatePluginConnectionRequest.Encoded

export const clockifyInput = {
  pluginConnectionId: "01890f6f-6d6a-7cc0-98d2-000000000205",
  providerId: "clockify",
  displayName: "Fixture Clockify",
  values: [
    { _tag: "secret", key: "apiKey", value: "fixture-clockify-key" },
    { _tag: "url", key: "webBaseUrl", value: "https://app.clockify.me/" },
    { _tag: "text", key: "workspaceId", value: "fixture-workspace" },
    { _tag: "text", key: "userIds", value: "fixture-owner" },
    { _tag: "integer", key: "pageSize", value: 20 },
    { _tag: "integer", key: "maximumPages", value: 2 },
    { _tag: "integer", key: "maximumConcurrency", value: 1 },
    { _tag: "integer", key: "operationTimeoutMillis", value: 5000 }
  ]
} satisfies typeof CreatePluginConnectionRequest.Encoded
