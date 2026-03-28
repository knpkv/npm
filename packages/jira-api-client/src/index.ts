/**
 * Root barrel export for `@knpkv/jira-api-client` -- openapi-fetch + Effect Jira REST client.
 *
 * **Mental model**
 *
 * - **Namespaced version**: `V3` re-exports the generated OpenAPI types (paths, components, operations).
 * - **Config + client split**: {@link JiraApiConfig} is provided separately from the
 *   generated client to support auth-polymorphic usage.
 * - **openapi-fetch wrapper**: {@link OpenApiFetchClient} provides Effect-based `execute` method
 *   around raw openapi-fetch clients.
 *
 * @packageDocumentation
 */

export { JiraApiClient, type JiraApiClientShape, layer } from "./JiraApiClient.js"

export { JiraApiConfig, type JiraApiConfigShape } from "./JiraApiConfig.js"

export { FetchClientError, type OpenApiFetchClient, type SuccessData, toEffect } from "./OpenApiFetchClient.js"

// Re-export generated V3 types
export type * as V3 from "./generated/v3/index.js"
