/**
 * OAuth2 authentication service for Jira CLI with token refresh and concurrency locking.
 *
 * **Mental model**
 *
 * - **Service pattern**: {@link JiraAuth} is a `Context.Tag` whose layer requires `HttpClient`,
 *   `ChildProcessSpawner` and `Crypto`. The flow — refresh lock, rotating-token persistence,
 *   browser login, profiles — is `@knpkv/atlassian-common/cli-auth`'s, bound to the
 *   `"jira-cli"` storage namespace, Jira's scopes and Jira's names.
 *
 * **Common tasks**
 *
 * - Get a valid access token: `auth.getAccessToken()` (auto-refreshes if expired)
 * - Full login flow: `auth.login()`
 * - Check auth state: `auth.isLoggedIn()`
 *
 * @module
 */
import {
  type AtlassianCliAuth,
  type AtlassianCliDescriptor,
  makeAtlassianCliAuth,
  NodeCliAuthLive
} from "@knpkv/atlassian-common/cli-auth"
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import type { AuthMissingError } from "./JiraCliError.js"
import { authMissing } from "./JiraCliError.js"

/** OAuth scopes for the Jira CLI. Granular scopes must also be enabled on the app in the developer console. */
const JIRA_CLI_SCOPES = [
  // Read issues, search, and read versions.
  "read:jira-work",
  // Edit issues and write worklogs.
  "write:jira-work",
  // Create a version (`POST /rest/api/3/version`), edit one (e.g. its
  // description) via `PUT /rest/api/3/version/{id}`, and manage version
  // "Related work" links (`/rest/api/3/version/{id}/relatedwork`).
  "manage:jira-project",
  // Resolve account IDs to display names for Driver/Contributors/Approvers.
  "read:jira-user",
  // Read the authenticated user's own profile (`/rest/api/3/myself`).
  "read:me",
  // Issue a refresh token so the CLI stays logged in across runs.
  "offline_access"
]

export type { AccessibleSite, LoginOptions } from "@knpkv/atlassian-common/cli-auth"

/**
 * JiraAuth service interface: the shared Atlassian CLI auth, failing with Jira's own
 * {@link AuthMissingError} when nobody is logged in.
 *
 * @category Services
 */
export interface JiraAuthService extends AtlassianCliAuth<AuthMissingError> {}

/**
 * JiraAuth service tag.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import { JiraAuth } from "@knpkv/jira-cli/JiraAuth"
 *
 * Effect.gen(function* () {
 *   const auth = yield* JiraAuth
 *   const isLoggedIn = yield* auth.isLoggedIn()
 *   if (!isLoggedIn) {
 *     yield* auth.login()
 *   }
 * })
 * ```
 *
 * @category Services
 */
export class JiraAuth extends Context.Service<
  JiraAuth,
  JiraAuthService
>()("@knpkv/jira-cli/JiraAuth") {}

/** Who the Jira CLI is: shared by its auth and its `auth` commands, so both name the same scopes. */
export const jiraCliDescriptor: AtlassianCliDescriptor = {
  commandName: "jira",
  productName: "Jira",
  scopes: JIRA_CLI_SCOPES
}

/**
 * Layer for JiraAuth service.
 *
 * @category Layers
 */
export const layer = Layer.effect(
  JiraAuth,
  makeAtlassianCliAuth({
    ...jiraCliDescriptor,
    toolName: "jira-cli",
    authMissing
  })
).pipe(Layer.provide(NodeCliAuthLive))
