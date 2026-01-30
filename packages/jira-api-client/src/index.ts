/**
 * Effect-based Jira Cloud REST API v3 client.
 *
 * @module
 */

// Main client
export { JiraApiClient, type JiraApiClientShape, layer } from "./JiraApiClient.js"

// Configuration
export { JiraApiConfig, type JiraApiConfigShape } from "./JiraApiConfig.js"

// V3 client - re-export everything from generated client
export * as V3 from "./generated/v3/Client.js"
