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
import type { OAuthError } from "@knpkv/atlassian-common/auth"
import { makeAtlassianCliAuth, NodeCliAuthLive } from "@knpkv/atlassian-common/cli-auth"
import type {
  AuthProfile,
  FileSystemError,
  HomeDirectoryError,
  OAuthConfig,
  OAuthUser
} from "@knpkv/atlassian-common/config"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as PlatformError from "effect/PlatformError"
import type * as Redacted from "effect/Redacted"
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

/**
 * Options for the login method.
 *
 * @category Types
 */
export interface LoginOptions {
  /** Site URL to select (for accounts with multiple sites) */
  readonly siteUrl?: string
}

/**
 * Information about an accessible Jira site.
 *
 * @category Types
 */
export interface AccessibleSite {
  readonly id: string
  readonly name: string
  readonly url: string
}

/**
 * JiraAuth service interface.
 *
 * @category Services
 */
export interface JiraAuthService {
  /** Configure OAuth client credentials */
  readonly configure: (
    config: OAuthConfig
  ) => Effect.Effect<void, FileSystemError | HomeDirectoryError | PlatformError.PlatformError>
  /** Check if OAuth is configured */
  readonly isConfigured: () => Effect.Effect<
    boolean,
    FileSystemError | HomeDirectoryError | PlatformError.PlatformError
  >
  /** Start OAuth login flow. Returns list of sites if multiple are available. */
  readonly login: (
    options?: LoginOptions
  ) => Effect.Effect<
    ReadonlyArray<AccessibleSite> | void,
    OAuthError | FileSystemError | HomeDirectoryError | PlatformError.PlatformError
  >
  /** Remove stored authentication */
  readonly logout: () => Effect.Effect<
    void,
    OAuthError | FileSystemError | HomeDirectoryError | PlatformError.PlatformError
  >
  /** Get access token, refreshing if needed */
  readonly getAccessToken: () => Effect.Effect<
    Redacted.Redacted<string>,
    AuthMissingError | OAuthError | FileSystemError | HomeDirectoryError | PlatformError.PlatformError
  >
  /** Get cloud ID from stored token */
  readonly getCloudId: () => Effect.Effect<
    string,
    AuthMissingError | FileSystemError | HomeDirectoryError | PlatformError.PlatformError
  >
  /** Get site URL from stored token */
  readonly getSiteUrl: () => Effect.Effect<
    string,
    AuthMissingError | FileSystemError | HomeDirectoryError | PlatformError.PlatformError
  >
  /** Get current user info from stored token */
  readonly getCurrentUser: () => Effect.Effect<
    OAuthUser | null,
    FileSystemError | HomeDirectoryError | PlatformError.PlatformError
  >
  /** Get active auth profile */
  readonly getActiveProfile: () => Effect.Effect<
    AuthProfile | null,
    FileSystemError | HomeDirectoryError | PlatformError.PlatformError
  >
  /** List stored auth profiles */
  readonly listProfiles: () => Effect.Effect<
    ReadonlyArray<AuthProfile>,
    FileSystemError | HomeDirectoryError | PlatformError.PlatformError
  >
  /** Switch active profile by ID, name, site URL, cloud ID, or account ID */
  readonly switchProfile: (
    selector: string
  ) => Effect.Effect<AuthProfile | null, FileSystemError | HomeDirectoryError | PlatformError.PlatformError>
  /** Remove stored profile by ID, name, site URL, cloud ID, or account ID */
  readonly removeProfile: (
    selector: string
  ) => Effect.Effect<AuthProfile | null, FileSystemError | HomeDirectoryError | PlatformError.PlatformError>
  /** Check if user is logged in */
  readonly isLoggedIn: () => Effect.Effect<boolean, FileSystemError | HomeDirectoryError | PlatformError.PlatformError>
}

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

/**
 * Layer for JiraAuth service.
 *
 * @category Layers
 */
export const layer = Layer.effect(
  JiraAuth,
  makeAtlassianCliAuth({
    toolName: "jira-cli",
    commandName: "jira",
    productName: "Jira",
    scopes: JIRA_CLI_SCOPES,
    authMissing
  })
).pipe(Layer.provide(NodeCliAuthLive))
