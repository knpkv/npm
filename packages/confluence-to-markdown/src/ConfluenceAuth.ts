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
import { CONFLUENCE_FOLDER_SCOPES, CONFLUENCE_SCOPES } from "@knpkv/atlassian-common/auth"
import {
  type AtlassianCliAuth,
  type AtlassianCliDescriptor,
  makeAtlassianCliAuth,
  NodeCliAuthLive
} from "@knpkv/atlassian-common/cli-auth"
import {
  FileSystemError,
  type HomeDirectoryError,
  HomeDirectoryTag,
  type OAuthConfig,
  OAuthConfigSchema
} from "@knpkv/atlassian-common/config"
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import type { HttpClient } from "effect/http"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
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

export type { AccessibleSite, LoginOptions } from "@knpkv/atlassian-common/cli-auth"

type SharedAuth = AtlassianCliAuth<AuthMissingError>

/**
 * ConfluenceAuth service interface: the shared Atlassian CLI auth, adapted. The Confluence client
 * takes the access token as a plain string, so `getAccessToken` unwraps it here, and nothing in this
 * CLI reads the site URL from auth, so `getSiteUrl` is not exposed.
 *
 * @category Services
 */
export interface ConfluenceAuthService extends Omit<SharedAuth, "getAccessToken" | "getSiteUrl"> {
  /** Get access token, refreshing if needed, unwrapped for the Confluence client. */
  readonly getAccessToken: () => Effect.Effect<string, Effect.Error<ReturnType<SharedAuth["getAccessToken"]>>>
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
