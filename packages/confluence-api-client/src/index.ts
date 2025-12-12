/**
 * @knpkv/confluence-api-client
 *
 * Effect-based Confluence Cloud REST API client (v1 + v2).
 *
 * @packageDocumentation
 */

export { ConfluenceApiConfig, type ConfluenceApiConfigShape } from "./ConfluenceApiConfig.js"

export { ConfluenceApiClient, type ConfluenceApiClientShape, layer } from "./ConfluenceApiClient.js"

// Re-export generated V1 client
export * as V1 from "./generated/v1/Client.js"

// Re-export generated V2 client
export * as V2 from "./generated/v2/Client.js"
