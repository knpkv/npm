/**
 * OAuth2 login, token refresh and profile management for an Atlassian CLI.
 *
 * **Mental model**
 *
 * - **One flow, many CLIs**: `jira` and `confluence` differ only in the storage
 *   namespace, scopes, the names in their messages and their "not logged in"
 *   error. {@link makeAtlassianCliAuth} takes those as options; each CLI keeps
 *   its own service tag and public interface and delegates to this.
 * - **Refresh lock**: a `Ref<Option<Deferred>>` prevents concurrent refreshes —
 *   the first caller refreshes, the others await the same Deferred.
 * - **Browser-based login**: starts a local callback server, opens the browser,
 *   and awaits the OAuth code with a 5-minute timeout. A browser that will not
 *   open is reported on stderr and the wait continues: the URL is printed first.
 *
 * @example
 * ```ts
 * const layer = Layer.effect(
 *   JiraAuth,
 *   makeAtlassianCliAuth({ toolName: "jira-cli", commandName: "jira", productName: "Jira", scopes, authMissing })
 * ).pipe(Layer.provide(NodeCliAuthLive))
 * ```
 *
 * @module
 */
import * as Clock from "effect/Clock"
import * as Console from "effect/Console"
import * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as HttpClient from "effect/http/HttpClient"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import { ChildProcessSpawner } from "effect/process"
import * as Redacted from "effect/Redacted"
import * as Ref from "effect/Ref"
import { buildAuthUrl, computeCodeChallenge, generateCodeVerifier } from "../auth/OAuthEndpoints.js"
import { OAuthError } from "../auth/OAuthErrors.js"
import {
  buildOAuthTokenAt,
  exchangeCodeForTokens,
  getAccessibleResources,
  getUserInfo,
  refreshToken,
  revokeToken
} from "../auth/OAuthOperations.js"
import { generateUUID } from "../auth/uuid.js"
import type { AuthProfile } from "../config/AuthProfiles.js"
import {
  deleteActiveProfile,
  deleteProfileBySelector,
  loadActiveProfile,
  loadActiveProfileToken,
  loadProfiles,
  saveProfileToken,
  setActiveProfileBySelector
} from "../config/AuthProfiles.js"
import type { HomeDirectoryError } from "../config/ConfigPaths.js"
import { HomeDirectoryTag } from "../config/ConfigPaths.js"
import type { OAuthConfig, OAuthToken, OAuthUser } from "../config/OAuthSchemas.js"
import type { FileSystemError } from "../config/TokenStorage.js"
import { isTokenExpiredAt, loadOAuthConfig, saveOAuthConfig } from "../config/TokenStorage.js"
import { callbackUrl, HttpServerFactoryTag, startCallbackServer } from "./internal/oauthServer.js"
import { openBrowser } from "./openBrowser.js"

type StorageError = FileSystemError | HomeDirectoryError | PlatformError.PlatformError

/**
 * What distinguishes one Atlassian CLI's auth from another's.
 *
 * @category Types
 */
export interface AtlassianCliAuthOptions<MissingError> {
  /** Storage namespace under `~/.config/atlassian/` (e.g. `"jira-cli"`). */
  readonly toolName: string
  /** Binary name used in hints such as "Run 'jira auth login'". */
  readonly commandName: string
  /** Product name used in "No Jira sites found for this account". */
  readonly productName: string
  /** OAuth scopes requested at login. */
  readonly scopes: ReadonlyArray<string>
  /** The CLI's own "not logged in" error, so callers keep catching their tag. */
  readonly authMissing: () => MissingError
  /**
   * Consulted only when the tool has no stored OAuth config; a config it returns
   * is saved under {@link toolName}, migrating it.
   */
  readonly legacyOAuthConfig?: Effect.Effect<
    OAuthConfig | null,
    FileSystemError | HomeDirectoryError,
    FileSystem.FileSystem | Path.Path | HomeDirectoryTag
  >
}

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
 * Information about an accessible Atlassian site.
 *
 * @category Types
 */
export interface AccessibleSite {
  readonly id: string
  readonly name: string
  readonly url: string
}

/**
 * The auth operations an Atlassian CLI exposes.
 *
 * @category Types
 */
export interface AtlassianCliAuth<MissingError> {
  /** Configure OAuth client credentials */
  readonly configure: (config: OAuthConfig) => Effect.Effect<void, StorageError>
  /** Check if OAuth is configured */
  readonly isConfigured: () => Effect.Effect<boolean, StorageError>
  /** Start OAuth login flow. Returns list of sites if multiple are available and none was chosen. */
  readonly login: (
    options?: LoginOptions
  ) => Effect.Effect<ReadonlyArray<AccessibleSite> | void, OAuthError | StorageError>
  /** Revoke (best effort) and remove stored authentication */
  readonly logout: () => Effect.Effect<void, OAuthError | StorageError>
  /** Get access token, refreshing if needed */
  readonly getAccessToken: () => Effect.Effect<Redacted.Redacted<string>, MissingError | OAuthError | StorageError>
  /** Get cloud ID from stored token */
  readonly getCloudId: () => Effect.Effect<string, MissingError | StorageError>
  /** Get site URL from stored token */
  readonly getSiteUrl: () => Effect.Effect<string, MissingError | StorageError>
  /** Get current user info from stored token */
  readonly getCurrentUser: () => Effect.Effect<OAuthUser | null, StorageError>
  /** Get active auth profile */
  readonly getActiveProfile: () => Effect.Effect<AuthProfile | null, StorageError>
  /** List stored auth profiles */
  readonly listProfiles: () => Effect.Effect<ReadonlyArray<AuthProfile>, StorageError>
  /** Switch active profile by ID, name, site URL, cloud ID, or account ID */
  readonly switchProfile: (selector: string) => Effect.Effect<AuthProfile | null, StorageError>
  /** Remove stored profile by ID, name, site URL, cloud ID, or account ID */
  readonly removeProfile: (selector: string) => Effect.Effect<AuthProfile | null, StorageError>
  /** Check if user is logged in */
  readonly isLoggedIn: () => Effect.Effect<boolean, StorageError>
}

type RefreshDeferred = Deferred.Deferred<OAuthToken, OAuthError | StorageError>

// Atlassian rotates refresh tokens: the response carries a replacement and the
// one we sent is consumed server-side. Interrupting between the round-trip and
// the save therefore destroys the credential — the next refresh fails and
// `getAccessToken` reacts by deleting the token file, so the user is silently
// logged out and has to log in again.
//
// Interruption is routine here, not hypothetical: this runs during layer
// construction on every CLI invocation, and jcf's nvim statusline kills the
// process on `VimLeave`. So the grant and the persist are atomic.
//
// The region carries its own deadline rather than relying on a caller's.
// `Effect.timeout` is a race, and racing an uninterruptible loser means waiting
// for it — an outer bound would go inert and, worse, an uninterruptible region
// with no deadline of its own absorbs SIGINT/SIGTERM entirely
// (`NodeRuntime.runMain`'s signal handlers only interrupt the main fiber),
// leaving a process that ignores Ctrl-C. The deadline forked inside the region
// is itself interruptible, so it does bound this.
//
// Abandoning the round-trip cannot prove the grant did not land: Atlassian may
// consume the refresh token and rotate it after we have stopped listening, and
// no client-side deadline changes that. So the deadline is paired with the rule
// in `getAccessToken` — a refresh that fails without a verdict never deletes the
// stored token. The credential survives to be retried, and only a real
// rejection ends the session.
const REFRESH_TIMEOUT = "30 seconds"

/**
 * Build an Atlassian CLI's auth operations.
 *
 * Requires an `HttpClient`, a `ChildProcessSpawner` (browser launch), `Crypto`
 * (PKCE), the callback-server factory, and the file system and home directory the
 * tokens are stored under. `NodeCliAuthLive` supplies the last three on Node.
 *
 * @category Constructors
 */
export const makeAtlassianCliAuth = Effect.fn("AtlassianCliAuth.make")(<MissingError>(
  options: AtlassianCliAuthOptions<MissingError>
): Effect.Effect<
  AtlassianCliAuth<MissingError>,
  never,
  | HttpClient.HttpClient
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | HttpServerFactoryTag
  | FileSystem.FileSystem
  | Path.Path
  | HomeDirectoryTag
> =>
  Effect.gen(function*() {
    const { authMissing, commandName, productName, scopes, toolName } = options
    const httpClient = yield* HttpClient.HttpClient
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const cryptoService = yield* Crypto.Crypto
    const serverFactory = yield* HttpServerFactoryTag

    const withHttp = Effect.provideService(HttpClient.HttpClient, httpClient)
    const withCrypto = Effect.provideService(Crypto.Crypto, cryptoService)
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const homeDirectory = yield* HomeDirectoryTag
    const withStorage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(HomeDirectoryTag, homeDirectory)
      )

    const loadToken = () => loadActiveProfileToken(toolName).pipe(withStorage)
    const saveToken = (token: OAuthToken) => saveProfileToken(toolName, token).pipe(withStorage)
    const deleteToken = () => deleteActiveProfile(toolName).pipe(withStorage)
    const saveConfig = (config: OAuthConfig) => saveOAuthConfig(toolName, config).pipe(withStorage)
    const legacyOAuthConfig = options.legacyOAuthConfig
    const loadConfig = Effect.fn("AtlassianCliAuth.loadConfig")(() =>
      Effect.gen(function*() {
        const config = yield* loadOAuthConfig(toolName)
        if (config !== null || legacyOAuthConfig === undefined) return config
        const legacy = yield* legacyOAuthConfig
        if (legacy !== null) {
          yield* saveOAuthConfig(toolName, legacy)
        }
        return legacy
      }).pipe(withStorage)
    )

    const refreshLock = yield* Ref.make<Option.Option<RefreshDeferred>>(Option.none())

    // The URL is printed before this runs, so a browser that will not open is
    // reported and the wait for the callback continues.
    const openBrowserOrWarn = Effect.fn("AtlassianCliAuth.openBrowserOrWarn")((url: string): Effect.Effect<void> =>
      openBrowser(url).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
        Effect.catchTags({
          BrowserOpenError: (error) =>
            Console.error(`Could not open a browser (${error.command} exited ${error.exitCode}); visit the URL above.`),
          PlatformError: () => Console.error("Could not open a browser; visit the URL above.")
        })
      )
    )

    const getConfig = Effect.fn("AtlassianCliAuth.getConfig")((): Effect.Effect<
      OAuthConfig,
      OAuthError | StorageError
    > =>
      Effect.gen(function*() {
        const config = yield* loadConfig()
        if (config === null) {
          return yield* new OAuthError({
            step: "authorize",
            cause: `OAuth not configured. Run '${commandName} auth configure' first.`
          })
        }
        return config
      })
    )

    const refreshAndPersist = Effect.fn("AtlassianCliAuth.refreshAndPersist")((
      token: OAuthToken,
      config: OAuthConfig
    ): Effect.Effect<OAuthToken, OAuthError | StorageError> =>
      Effect.uninterruptible(
        Effect.gen(function*() {
          const updated = yield* refreshToken(token, config).pipe(
            withHttp,
            Effect.timeout(REFRESH_TIMEOUT),
            Effect.catchTag(
              "TimeoutError",
              () => Effect.fail(new OAuthError({ step: "refresh", cause: `no response within ${REFRESH_TIMEOUT}` }))
            )
          )
          yield* saveToken(updated)
          return updated
        })
      )
    )

    const isConfigured = Effect.fn("AtlassianCliAuth.isConfigured")(() =>
      loadConfig().pipe(Effect.map((config) => config !== null))
    )

    const login = Effect.fn("AtlassianCliAuth.login")((
      loginOptions?: LoginOptions
    ): Effect.Effect<ReadonlyArray<AccessibleSite> | void, OAuthError | StorageError> =>
      Effect.gen(function*() {
        const config = yield* getConfig()
        const state = yield* generateUUID().pipe(withCrypto)
        const codeVerifier = yield* generateCodeVerifier().pipe(withCrypto)
        const codeChallenge = yield* computeCodeChallenge(codeVerifier).pipe(withCrypto)

        const { code, port } = yield* Effect.scoped(
          Effect.gen(function*() {
            const { codePromise, port } = yield* startCallbackServer(state).pipe(
              Effect.provideService(HttpServerFactoryTag, serverFactory)
            )
            const authUrl = buildAuthUrl({
              clientId: config.clientId,
              state,
              port,
              redirectUri: callbackUrl(port),
              scopes: [...scopes],
              codeChallenge
            })

            yield* Console.log(`Opening browser for Atlassian login (callback on port ${port})...`)
            yield* Console.log(`If browser doesn't open, visit: ${authUrl}`)
            yield* openBrowserOrWarn(authUrl)
            yield* Console.log("Waiting for authorization (press Ctrl+C to cancel)...")

            const code = yield* codePromise.pipe(
              Effect.timeout("5 minutes"),
              Effect.catchTag(
                "TimeoutError",
                () => Effect.fail(new OAuthError({ step: "authorize", cause: "Authorization timed out" }))
              )
            )
            return { code, port }
          })
        )

        yield* Console.log("Exchanging code for tokens...")
        const tokens = yield* exchangeCodeForTokens(code, config, {
          port,
          redirectUri: callbackUrl(port),
          codeVerifier
        }).pipe(withHttp)

        yield* Console.log("Fetching accessible sites...")
        const sites = yield* getAccessibleResources(tokens.access_token).pipe(withHttp)

        if (sites.length === 0) {
          return yield* new OAuthError({
            step: "authorize",
            cause: `No ${productName} sites found for this account`
          })
        }

        let site: (typeof sites)[number]

        if (sites.length > 1) {
          const siteUrl = loginOptions?.siteUrl
          if (siteUrl !== undefined && siteUrl !== "") {
            const matched = sites.find((s) => s.url === siteUrl)
            if (matched === undefined) {
              const available = sites.map((s) => `  - ${s.name}: ${s.url}`).join("\n")
              return yield* new OAuthError({
                step: "authorize",
                cause: `Site '${siteUrl}' not found. Available sites:\n${available}`
              })
            }
            site = matched
          } else {
            yield* Console.log(`Multiple ${productName} sites found. Please select one:`)
            for (const s of sites) {
              yield* Console.log(`  - ${s.name}: ${s.url}`)
            }
            yield* Console.log(`\nRun '${commandName} auth login --site <url>' to select a site`)
            return sites.map((s) => ({ id: s.id, name: s.name, url: s.url }))
          }
        } else {
          site = sites[0]!
        }

        yield* Console.log("Fetching user info...")
        const user = yield* getUserInfo(tokens.access_token).pipe(withHttp)

        const nowMs = yield* Clock.currentTimeMillis
        yield* saveToken(buildOAuthTokenAt(tokens, site, user, nowMs))
        yield* Console.log(`Logged in as ${user.name} (${user.email})`)
        return undefined
      })
    )

    const logout = Effect.fn("AtlassianCliAuth.logout")((): Effect.Effect<void, OAuthError | StorageError> =>
      Effect.gen(function*() {
        const token = yield* loadToken()
        if (token === null) {
          yield* Console.log("Not logged in")
          return
        }

        const config = yield* loadConfig()
        if (config !== null) {
          yield* revokeToken(token, config).pipe(
            withHttp,
            Effect.tap(() => Effect.log("Token revoked with Atlassian")),
            Effect.catch((error) => Effect.log(`Warning: Failed to revoke token: ${error.message}`))
          )
        }

        yield* deleteToken()
      })
    )

    const getAccessToken = Effect.fn("AtlassianCliAuth.getAccessToken")((): Effect.Effect<
      Redacted.Redacted<string>,
      MissingError | OAuthError | StorageError
    > =>
      Effect.gen(function*() {
        const token = yield* loadToken()
        if (token === null) {
          return yield* Effect.fail(authMissing())
        }

        const nowMs = yield* Clock.currentTimeMillis
        if (!isTokenExpiredAt(token, nowMs)) {
          return Redacted.make(token.access_token)
        }

        // Atomically check-then-set refresh lock to avoid TOCTOU race
        const deferred = yield* Deferred.make<OAuthToken, OAuthError | StorageError>()
        const existing = yield* Ref.modify(refreshLock, (current) =>
          Option.isSome(current)
            ? ([current.value, current] satisfies readonly [RefreshDeferred, Option.Option<RefreshDeferred>])
            : ([deferred, Option.some(deferred)] satisfies readonly [RefreshDeferred, Option.Option<RefreshDeferred>]))

        // Another fiber is already refreshing — just await its result
        if (existing !== deferred) {
          const refreshed = yield* Deferred.await(existing)
          return Redacted.make(refreshed.access_token)
        }

        const refresh = Effect.gen(function*() {
          const config = yield* getConfig()
          // stderr, not stdout: this fires from inside layer construction, so it
          // lands ahead of whatever the command prints. On `--json` that used to
          // put a line of prose in front of the document, and the release
          // automation parsing it failed *after* the remote writes had happened.
          yield* Console.error("Token expired, refreshing...")
          return yield* refreshAndPersist(token, config)
        }).pipe(
          Effect.catchTag("OAuthError", (error) => {
            // Discard the stored credential only when Atlassian actually rejected
            // it. A refresh can fail without saying anything about the token —
            // transport error, timeout, interruption — and in those cases the
            // grant may even have been consumed server-side, so the one thing we
            // must not do is delete the replacement's only trail. Deleting on any
            // `step === "refresh"` failure turned a flaky network into a silent
            // logout, which is worse than retrying and is unrecoverable.
            //
            // Not every 4xx is a verdict either. `429` is the one this most needs
            // to survive — several `jira`/`jcf` processes on an expired token hit
            // the endpoint together, one wins the rotation and the rest are
            // rate-limited — while `408`/`425` restate the timeout case and `407`
            // and other middlebox replies never came from Atlassian at all.
            //
            // Status alone is still too coarse. `refreshToken` sends the client
            // credentials in the body, so a wrong or rotated `clientSecret` comes
            // back as `400 invalid_client`; deleting the token there destroys a
            // working credential over a config problem, and the re-login it forces
            // would fail the same way until `auth configure` is run. Only
            // `invalid_grant` means the stored token itself is spent, and that is
            // the only thing that ends the session — on a `403` too, since a bare
            // 403 is just as likely to come from a proxy or WAF as from Atlassian
            // revoking anything. An unparseable body leaves `errorCode` absent and
            // the token in place.
            const { errorCode, status } = error
            const rejected = errorCode === "invalid_grant" && (status === 400 || status === 403)
            if (error.step === "refresh" && rejected) {
              return Effect.gen(function*() {
                yield* deleteToken()
                return yield* new OAuthError({
                  step: "refresh",
                  cause: `Refresh token expired. Please run '${commandName} auth login' to re-authenticate.`,
                  status,
                  errorCode
                })
              })
            }
            return Effect.fail(error)
          })
        )

        // This fiber owns the refresh. Complete the shared Deferred with the final
        // transformed exit so waiters observe the same success or failure.
        const exit = yield* refresh.pipe(
          Effect.exit,
          Effect.ensuring(Ref.set(refreshLock, Option.none()))
        )
        yield* Deferred.done(deferred, exit)
        const result = yield* Deferred.await(deferred)

        return Redacted.make(result.access_token)
      })
    )

    const storedTokenField = <A>(read: (token: OAuthToken) => A) => (): Effect.Effect<A, MissingError | StorageError> =>
      loadToken().pipe(
        Effect.flatMap((token) => token === null ? Effect.fail(authMissing()) : Effect.succeed(read(token)))
      )

    return {
      configure: Effect.fn("AtlassianCliAuth.configure")(saveConfig),
      isConfigured,
      login,
      logout,
      getAccessToken,
      getCloudId: Effect.fn("AtlassianCliAuth.getCloudId")(storedTokenField((token) => token.cloud_id)),
      getSiteUrl: Effect.fn("AtlassianCliAuth.getSiteUrl")(storedTokenField((token) => token.site_url)),
      getCurrentUser: Effect.fn("AtlassianCliAuth.getCurrentUser")(() =>
        loadToken().pipe(Effect.map((token) => token?.user ?? null))
      ),
      getActiveProfile: Effect.fn("AtlassianCliAuth.getActiveProfile")(() =>
        loadActiveProfile(toolName).pipe(withStorage)
      ),
      listProfiles: Effect.fn("AtlassianCliAuth.listProfiles")(() =>
        loadProfiles(toolName).pipe(Effect.map((store) => store.profiles), withStorage)
      ),
      switchProfile: Effect.fn("AtlassianCliAuth.switchProfile")((selector) =>
        setActiveProfileBySelector(toolName, selector).pipe(withStorage)
      ),
      removeProfile: Effect.fn("AtlassianCliAuth.removeProfile")((selector) =>
        deleteProfileBySelector(toolName, selector).pipe(withStorage)
      ),
      isLoggedIn: Effect.fn("AtlassianCliAuth.isLoggedIn")(() =>
        loadToken().pipe(Effect.map((token) => token !== null))
      )
    }
  })
)
