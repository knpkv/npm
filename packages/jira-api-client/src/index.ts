/**
 * Schema-validated Effect client for Jira Cloud REST API v3.
 *
 * @packageDocumentation
 */

export { JiraApiClient, type JiraApiClientContract, layer, make, type UploadAttachmentInput } from "./JiraApiClient.js"

export { JiraApiConfig, type JiraApiConfigContract } from "./JiraApiConfig.js"

export * as JiraApi from "./generated/JiraApi.js"
