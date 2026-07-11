/**
 * Schema-validated Effect client for Jira Cloud REST API v3.
 *
 * @packageDocumentation
 */

export { JiraApiClient, type JiraApiClientShape, layer, make, type UploadAttachmentInput } from "./JiraApiClient.js"

export { JiraApiConfig, type JiraApiConfigShape } from "./JiraApiConfig.js"

export * as JiraApi from "./generated/JiraApi.js"
