/**
 * Confluence API client configuration.
 *
 * @module
 */
import * as Context from "effect/Context"
import type * as Redacted from "effect/Redacted"

/**
 * Configuration shape for Confluence API client.
 *
 * @category Config
 */
export interface ConfluenceApiConfigShape {
  readonly baseUrl: string
  readonly auth:
    | { readonly type: "basic"; readonly email: string; readonly apiToken: Redacted.Redacted<string> }
    | { readonly type: "oauth2"; readonly accessToken: Redacted.Redacted<string>; readonly cloudId: string }
}

/**
 * Confluence API configuration service.
 *
 * @example
 * ```typescript
 * import { ConfluenceApiConfig } from "@knpkv/confluence-api-client"
 * import * as Redacted from "effect/Redacted"
 * import * as Layer from "effect/Layer"
 *
 * const configLayer = Layer.succeed(ConfluenceApiConfig, {
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
export class ConfluenceApiConfig extends Context.Tag(
  "@knpkv/confluence-api-client/ConfluenceApiConfig"
)<ConfluenceApiConfig, ConfluenceApiConfigShape>() {}
