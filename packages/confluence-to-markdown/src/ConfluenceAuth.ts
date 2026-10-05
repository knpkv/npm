/**
 * OAuth2 authentication service for Confluence with shared Atlassian profiles.
 *
 * **Mental model**
 *
 * - The flow — refresh lock, rotating-token persistence, browser login, profiles —
 *   is `@knpkv/atlassian-common/cli-auth`'s, bound to the `"confluence-to-markdown"`
 *   storage namespace, Confluence's scopes and Confluence's names.
 * - A config left in the pre-profiles `~/.confluence/config.json` is migrated on first read.
 * - The public service keeps Confluence's plain-string access token return type.
 *
 * @module
 */
import { CONFLUENCE_FOLDER_SCOPES, CONFLUENCE_SCOPES, type OAuthError } from "@knpkv/atlassian-common/auth"
import { type AtlassianCliDescriptor, makeAtlassianCliAuth, NodeCliAuthLive } from "@knpkv/atlassian-common/cli-auth"
import {
  type AuthProfile,
  FileSystemError,
  type HomeDirectoryError,
  HomeDirectoryTag,
  type OAuthConfig,
  OAuthConfigSchema,
  type OAuthUser
} from "@knpkv/atlassian-common/config"
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import type { HttpClient } from "effect/http"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import type { ChildProcessSpawner } from "effect/process"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { AuthMissingError } from "./ConfluenceError.js"

const LEGACY_CONFIG_DIR_NAME = ".confluence"

/**
 * What this CLI asks for at login: the shared page/attachment set plus the
 * folder and CQL-search scopes its `folder`/`search` commands need.
 *
 * The union lives here rather than in `CONFLUENCE_SCOPES` so control-center,
 * which shares that constant for its own sign-in, keeps requesting only the
 * scopes it actually uses.
 *
 * Exported so `auth create`/`auth manage` can print the scopes to enable on the
 * OAuth app from the same source login reads. Atlassian rejects an authorization
 * request naming a scope the app does not enable, so a hand-maintained list in
 * the setup instructions drifts into telling users to configure an app that
 * cannot complete a login.
 *
 * @category Scopes
 */
export const CLI_LOGIN_SCOPES = [...CONFLUENCE_SCOPES, ...CONFLUENCE_FOLDER_SCOPES]

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))

const parseJsonOrNull = (content: string): Schema.Json | null => {
  try {
    return decodeJson(content)
  } catch {
    return null
  }
}

const getLegacyConfigPath = (fileName: string) =>
  Effect.gen(function*() {
    const homeDirectory = yield* HomeDirectoryTag
    const path = yield* Path.Path
    const home = yield* homeDirectory.get()
    return path.join(home, LEGACY_CONFIG_DIR_NAME, fileName)
  })

const readLegacyJson = (
  fileName: string
): Effect.Effect<
  unknown | null,
  FileSystemError | HomeDirectoryError,
  FileSystem.FileSystem | Path.Path | HomeDirectoryTag
> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const filePath = yield* getLegacyConfigPath(fileName)
    const exists = yield* fs.exists(filePath).pipe(
      Effect.catch(() => Effect.succeed(false))
    )
    if (!exists) return null

    const content = yield* fs.readFileString(filePath).pipe(
      Effect.mapError((cause) => new FileSystemError({ operation: "read", path: filePath, cause }))
    )

    const parsed = parseJsonOrNull(content)
    if (parsed === null) return null

    return parsed
  })

const loadLegacyOAuthConfig = (): Effect.Effect<
  OAuthConfig | null,
  FileSystemError | HomeDirectoryError,
  FileSystem.FileSystem | Path.Path | HomeDirectoryTag
> =>
  Effect.gen(function*() {
    const parsed = yield* readLegacyJson("config.json")
    if (parsed === null) return null
    return yield* Schema.decodeUnknownEffect(OAuthConfigSchema)(parsed).pipe(
      Effect.catch(() => Effect.succeed(null))
    )
  })

/**
 * Options for the login method.
 */
export interface LoginOptions {
  /** Site URL to select (for accounts with multiple sites) */
  readonly siteUrl?: string
}

/**
 * Information about an accessible Confluence site.
 */
export interface AccessibleSite {
  readonly id: string
  readonly name: string
  readonly url: string
}

/**
 * ConfluenceAuth service interface.
 *
 * @category Services
 */
export interface ConfluenceAuthService {
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
    string,
    AuthMissingError | OAuthError | FileSystemError | HomeDirectoryError | PlatformError.PlatformError
  >
  /** Get cloud ID from stored token */
  readonly getCloudId: () => Effect.Effect<
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
 * ConfluenceAuth service tag.
 *
 * @category Services
 */
export class ConfluenceAuth extends Context.Service<
  ConfluenceAuth,
  ConfluenceAuthService
>()("@knpkv/confluence-to-markdown/ConfluenceAuth") {}

/** Who the Confluence CLI is: shared by its auth and its `auth` commands, so both name the same scopes. */
export const confluenceCliDescriptor: AtlassianCliDescriptor = {
  commandName: "confluence",
  productName: "Confluence",
  scopes: CLI_LOGIN_SCOPES
}

/**
 * Layer for ConfluenceAuth service.
 *
 * @category Layers
 */
export const layer: Layer.Layer<
  ConfluenceAuth,
  never,
  HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> = Layer.effect(
  ConfluenceAuth,
  Effect.map(
    makeAtlassianCliAuth({
      ...confluenceCliDescriptor,
      toolName: "confluence-to-markdown",
      authMissing: () => new AuthMissingError(),
      legacyOAuthConfig: loadLegacyOAuthConfig()
    }),
    (auth) =>
      ConfluenceAuth.of({
        configure: auth.configure,
        isConfigured: auth.isConfigured,
        login: auth.login,
        logout: auth.logout,
        // The public type is a plain string for compatibility; unwrap here only.
        getAccessToken: () => auth.getAccessToken().pipe(Effect.map(Redacted.value)),
        getCloudId: auth.getCloudId,
        getCurrentUser: auth.getCurrentUser,
        getActiveProfile: auth.getActiveProfile,
        listProfiles: auth.listProfiles,
        switchProfile: auth.switchProfile,
        removeProfile: auth.removeProfile,
        isLoggedIn: auth.isLoggedIn
      })
  )
).pipe(Layer.provide(NodeCliAuthLive))
