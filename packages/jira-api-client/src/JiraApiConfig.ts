/**
 * Configuration service tag for the Jira API client (basic or OAuth2 auth).
 *
 * **Mental model**
 *
 * - **Discriminated auth union**: The `auth` field is `{ type: "basic", ... } | { type: "oauth2", ... }`.
 *   Basic auth uses email + Redacted API token; OAuth2 uses Redacted access token + cloud ID.
 * - **Base URL routing**: For OAuth2, the base URL is derived from cloud ID (`api.atlassian.com/ex/jira/{cloudId}`);
 *   for basic auth, `baseUrl` is used directly.
 * - **`auth` is a snapshot; `resolveAuth` is a subscription.** A credential that can expire needs the
 *   second one — see its own note.
 *
 * @module
 */
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Redacted from "effect/Redacted"

/** How a request proves who is asking. */
export type JiraApiCredential =
  | { readonly type: "basic"; readonly email: string; readonly apiToken: Redacted.Redacted<string> }
  | { readonly type: "oauth2"; readonly accessToken: Redacted.Redacted<string>; readonly cloudId: string }

/**
 * Configuration shape for Jira API client.
 *
 * @category Config
 */
export interface JiraApiConfigContract {
  readonly baseUrl: string
  readonly auth: JiraApiCredential
  /**
   * Re-read before every request, when supplied. Otherwise `auth` is used as given.
   *
   * A `Redacted` token is a value, so a client built from one is pinned to it for as long as the
   * client lives. That is invisible in a command that exits in seconds and fatal in one that does
   * not: an Atlassian access token lasts about an hour, after which every request 401s and no amount
   * of retrying inside the process can recover, because the expired token is baked into the header.
   * `jcf watch` is meant to run all day, so it supplies this and a refresh reaches the next request.
   *
   * Typed as infallible on purpose. This runs inside request preprocessing, where a new error would
   * widen every operation's error channel; a resolver that cannot read its credential yields
   * whatever it has, and the 401 that follows is the same one an absent login already produces.
   */
  readonly resolveAuth?: Effect.Effect<JiraApiCredential> | undefined
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
export class JiraApiConfig extends Context.Service<JiraApiConfig, JiraApiConfigContract>()(
  "@knpkv/jira-api-client/JiraApiConfig"
) {}
