/**
 * Root barrel export for `@knpkv/confluence-api-client` — auto-generated V1/V2 Confluence REST clients.
 *
 * **Mental model**
 *
 * - **Namespaced versions**: `V1` and `V2` re-export the full generated client interfaces.
 *   Consumer code picks the version matching their API needs.
 * - **Config + client split**: {@link ConfluenceApiConfig} is provided separately from the
 *   generated clients to support auth-polymorphic usage.
 *
 * @packageDocumentation
 */

export { ConfluenceApiConfig, type ConfluenceApiConfigShape } from "./ConfluenceApiConfig.js"

export { ConfluenceApiClient, type ConfluenceApiClientShape, layer } from "./ConfluenceApiClient.js"

// Re-export generated V1 client
export * as V1 from "./generated/v1/Client.js"

// Re-export generated V2 client
export * as V2 from "./generated/v2/Client.js"
