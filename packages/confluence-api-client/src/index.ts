/**
 * Root barrel export for `@knpkv/confluence-api-client` -- openapi-fetch + Effect Confluence REST clients.
 *
 * **Mental model**
 *
 * - **Namespaced versions**: `V1` and `V2` re-export the generated OpenAPI types (paths, components, operations).
 * - **Config + client split**: {@link ConfluenceApiConfig} is provided separately from the
 *   generated clients to support auth-polymorphic usage.
 * - **openapi-fetch wrapper**: {@link OpenApiFetchClient} provides Effect-based `execute` method
 *   around raw openapi-fetch clients.
 *
 * @packageDocumentation
 */

export { ConfluenceApiConfig, type ConfluenceApiConfigShape } from "./ConfluenceApiConfig.js"

export { ConfluenceApiClient, type ConfluenceApiClientShape, layer } from "./ConfluenceApiClient.js"

export { FetchClientError, type OpenApiFetchClient, type SuccessData, toEffect } from "./OpenApiFetchClient.js"

// Re-export generated V1 types
export type * as V1 from "./generated/v1/index.js"

// Re-export generated V2 types
export type * as V2 from "./generated/v2/index.js"
