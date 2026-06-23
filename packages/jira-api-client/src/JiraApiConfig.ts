/**
 * Configuration service tag for the Jira API client (basic or OAuth2 auth).
 *
 * **Mental model**
 *
 * - **Discriminated auth union**: The `auth` field is `{ type: "basic", ... } | { type: "oauth2", ... }`.
 *   Basic auth uses email + Redacted API token; OAuth2 uses Redacted access token + cloud ID.
 * - **Base URL routing**: For OAuth2, the base URL is derived from cloud ID (`api.atlassian.com/ex/jira/{cloudId}`);
 *   for basic auth, `baseUrl` is used directly.
 *
 * @module
 */
import * as Context from "effect/Context"
import type * as Redacted from "effect/Redacted"

/**
 * Configuration shape for Jira API client.
 *
 * @category Config
 */
export interface JiraApiConfigShape {
  readonly baseUrl: string
  readonly auth:
    | { readonly type: "basic"; readonly email: string; readonly apiToken: Redacted.Redacted<string> }
    | { readonly type: "oauth2"; readonly accessToken: Redacted.Redacted<string>; readonly cloudId: string }
}

/**
 * Jira API configuration service.
 *
 * @example
 * ```typescript
 * import { JiraApiConfig } from "@knpkv/jira-api-client"
 * import * as Redacted from "effect/Redacted"
 * import * as Layer from "effect/Layer"
 *
 * const configLayer = Layer.succeed(JiraApiConfig, {
 *   baseUrl: "https://mysite.atlassian.net",
 *   auth: {
 *     type: "basic",
 *     email: "user@example.com",
 *     apiToken: Redacted.make("token")
 *   }
 * })
 * ```
 *
 * @category Config
 */
export class JiraApiConfig extends Context.Service<JiraApiConfig, JiraApiConfigShape>()(
  "@knpkv/jira-api-client/JiraApiConfig"
) {}
