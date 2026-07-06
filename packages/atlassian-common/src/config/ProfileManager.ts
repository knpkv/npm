/**
 * Unified Atlassian profile management helpers shared by Atlassian CLIs.
 *
 * @module
 */
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import * as Schema from "effect/Schema"
import type { HttpClient } from "effect/unstable/http"
import type { OAuthError } from "../auth/OAuthErrors.js"
import { refreshToken } from "../auth/OAuthOperations.js"
import {
  type AuthProfile,
  type AuthProfilesFile,
  findProfile,
  loadProfiles,
  saveProfiles,
  saveProfileToken
} from "./AuthProfiles.js"
import { getProfilesPath, type HomeDirectoryError, HomeDirectoryTag } from "./ConfigPaths.js"
import { type OAuthToken, OAuthTokenSchema } from "./OAuthSchemas.js"
import { FileSystemError, isTokenExpired, loadOAuthConfig } from "./TokenStorage.js"

export interface AtlassianToolDefinition {
  readonly toolName: string
  readonly authStoreName?: string
  readonly legacyAuthPath?: ReadonlyArray<string>
  readonly label: string
  readonly loginHint: string
  readonly requiredScopes: ReadonlyArray<string>
}

export const JIRA_REQUIRED_SCOPES: ReadonlyArray<string> = [
  "read:jira-work",
  "write:jira-work",
  "manage:jira-project",
  "read:jira-user",
  "read:me",
  "offline_access"
]

export const CONFLUENCE_REQUIRED_SCOPES: ReadonlyArray<string> = [
  "read:page:confluence",
  "write:page:confluence",
  "delete:page:confluence",
  "read:me",
  "offline_access"
]

export const ATLASSIAN_TOOLS: ReadonlyArray<AtlassianToolDefinition> = [
  {
    toolName: "jira-cli",
    label: "Jira CLI",
    loginHint: "jira auth login",
    requiredScopes: JIRA_REQUIRED_SCOPES
  },
  {
    toolName: "confluence-to-markdown",
    legacyAuthPath: [".confluence", "auth.json"],
    label: "Confluence to Markdown",
    loginHint: "confluence auth login",
    requiredScopes: CONFLUENCE_REQUIRED_SCOPES
  },
  {
    toolName: "jira-clockify",
    authStoreName: "jira-cli",
    label: "Jira Clockify",
    loginHint: "jcf auth jira login",
    requiredScopes: JIRA_REQUIRED_SCOPES
  }
]

export type ProfileTokenStatus = "valid" | "expired"

export class ProfileNotFoundError extends Data.TaggedError("ProfileNotFoundError")<{
  readonly selector: string
}> {
  override get message(): string {
    return `Profile not found: ${this.selector}`
  }
}

export class MissingOAuthConfigError extends Data.TaggedError("MissingOAuthConfigError")<{
  readonly authStoreName: string
  readonly profileId: string
}> {
  override get message(): string {
    return `Cannot refresh expired profile ${this.profileId}: missing OAuth config for ${this.authStoreName}`
  }
}

export interface ToolProfileStatus {
  readonly tool: AtlassianToolDefinition
  readonly authStoreName: string
  readonly activeProfile: AuthProfile | null
  readonly profiles: ReadonlyArray<AuthProfile>
  readonly tokenStatus: ProfileTokenStatus | "missing"
  readonly missingScopes: ReadonlyArray<string>
  readonly oauthConfigured: boolean
}

const authStoreName = (tool: AtlassianToolDefinition): string => tool.authStoreName ?? tool.toolName

const toolStorePair = (
  tool: AtlassianToolDefinition,
  store: AuthProfilesFile
): readonly [AtlassianToolDefinition, AuthProfilesFile] => [tool, store]

const uniqueAuthTools = (tools: ReadonlyArray<AtlassianToolDefinition>): ReadonlyArray<AtlassianToolDefinition> =>
  tools.filter((tool, index) =>
    tools.findIndex((candidate) => authStoreName(candidate) === authStoreName(tool)) === index
  )

const loadLegacyToken = (
  tool: AtlassianToolDefinition
): Effect.Effect<
  OAuthToken | null,
  FileSystemError | HomeDirectoryError,
  FileSystem.FileSystem | Path.Path | HomeDirectoryTag
> =>
  Effect.gen(function*() {
    if (!tool.legacyAuthPath) return null
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const homeDirectory = yield* HomeDirectoryTag
    const home = yield* homeDirectory.get()
    const authPath = path.join(home, ...tool.legacyAuthPath)
    const exists = yield* fs.exists(authPath).pipe(Effect.catch(() => Effect.succeed(false)))
    if (!exists) return null
    const content = yield* fs.readFileString(authPath).pipe(
      Effect.mapError((cause) => new FileSystemError({ operation: "read", path: authPath, cause }))
    )
    const parsed = yield* Effect.try({
      try: () => JSON.parse(content),
      catch: (cause) => cause
    }).pipe(Effect.catch(() => Effect.succeed(null)))
    if (parsed === null) return null
    return yield* Schema.decodeUnknownEffect(OAuthTokenSchema)(parsed).pipe(
      Effect.catch(() => Effect.succeed(null))
    )
  })

export const tokenScopes = (token: OAuthToken): ReadonlySet<string> =>
  new Set(token.scope.split(/\s+/).filter((scope: string) => scope.length > 0))

export const missingScopes = (
  token: OAuthToken,
  requiredScopes: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const granted = tokenScopes(token)
  return requiredScopes.filter((scope) => !granted.has(scope))
}

export const inspectToolProfiles = (
  tool: AtlassianToolDefinition
): Effect.Effect<
  ToolProfileStatus,
  FileSystemError | HomeDirectoryError,
  FileSystem.FileSystem | Path.Path | HomeDirectoryTag
> =>
  Effect.gen(function*() {
    const storeName = authStoreName(tool)
    const [store, config] = yield* Effect.all([loadProfiles(storeName), loadOAuthConfig(storeName)])
    const activeProfile = store.profiles.find((profile) => profile.id === store.activeProfileId) ?? store.profiles[0] ??
      null
    return {
      tool,
      authStoreName: storeName,
      activeProfile,
      profiles: store.profiles,
      tokenStatus: activeProfile === null ? "missing" : isTokenExpired(activeProfile.token, 0) ? "expired" : "valid",
      missingScopes: activeProfile === null ? [] : missingScopes(activeProfile.token, tool.requiredScopes),
      oauthConfigured: config !== null
    }
  })

export const inspectAllToolProfiles = (
  tools: ReadonlyArray<AtlassianToolDefinition> = ATLASSIAN_TOOLS
) => Effect.forEach(tools, inspectToolProfiles)

/**
 * Switch matching existing profiles across auth stores.
 *
 * Fails when the selector is not present in any store so callers do not
 * mistake an unchanged profile list for a successful switch.
 */
export const useProfileForAllTools = (
  selector: string,
  tools: ReadonlyArray<AtlassianToolDefinition> = ATLASSIAN_TOOLS
): Effect.Effect<
  ReadonlyArray<ToolProfileStatus>,
  ProfileNotFoundError | FileSystemError | HomeDirectoryError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | HomeDirectoryTag
> =>
  Effect.gen(function*() {
    const authTools = uniqueAuthTools(tools)
    const stores = yield* Effect.forEach(authTools, (tool) =>
      loadProfiles(authStoreName(tool)).pipe(Effect.map((store) => toolStorePair(tool, store))))
    const selected = stores.map(([, store]) =>
      findProfile(store.profiles, selector)
    ).find((profile): profile is AuthProfile =>
      profile !== null
    )
    if (!selected) return yield* Effect.fail(new ProfileNotFoundError({ selector }))

    yield* Effect.forEach(stores, ([tool, store]) => {
      const matching = findProfile(store.profiles, selector) ?? findProfile(store.profiles, selected.id)
      if (!matching) return Effect.void
      return saveProfiles(authStoreName(tool), { ...store, activeProfileId: matching.id })
    })
    return yield* inspectAllToolProfiles(tools)
  })

/**
 * Persist legacy single-token auth files into shared profile stores.
 *
 * Supports both XDG Atlassian auth files and tool-specific legacy paths such
 * as Confluence's historical `~/.confluence/auth.json`.
 */
export const migrateLegacyProfiles = (
  tools: ReadonlyArray<AtlassianToolDefinition> = ATLASSIAN_TOOLS
): Effect.Effect<
  ReadonlyArray<ToolProfileStatus>,
  FileSystemError | HomeDirectoryError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | HomeDirectoryTag
> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* Effect.forEach(uniqueAuthTools(tools), (tool) =>
      Effect.gen(function*() {
        const storeName = authStoreName(tool)
        const profilesPath = yield* getProfilesPath(storeName)
        const hasProfilesFile = yield* fs.exists(profilesPath).pipe(Effect.catch(() => Effect.succeed(false)))
        if (hasProfilesFile) return
        const store = yield* loadProfiles(storeName)
        if (store.profiles.length > 0) {
          yield* saveProfiles(storeName, store)
          return
        }
        const legacyToken = yield* loadLegacyToken(tool)
        if (legacyToken !== null) {
          yield* saveProfileToken(storeName, legacyToken)
        }
      }))
    return yield* inspectAllToolProfiles(tools)
  })

/**
 * Refresh expired active profiles.
 *
 * Fails when an expired profile lacks OAuth client configuration so refresh
 * callers cannot report success while leaving a token expired.
 */
export const refreshActiveProfiles = (
  tools: ReadonlyArray<AtlassianToolDefinition> = ATLASSIAN_TOOLS
): Effect.Effect<
  ReadonlyArray<ToolProfileStatus>,
  MissingOAuthConfigError | OAuthError | FileSystemError | HomeDirectoryError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | HomeDirectoryTag | HttpClient.HttpClient
> =>
  Effect.gen(function*() {
    yield* Effect.forEach(uniqueAuthTools(tools), (tool) =>
      Effect.gen(function*() {
        const storeName = authStoreName(tool)
        const store = yield* loadProfiles(storeName)
        const active = store.profiles.find((profile) => profile.id === store.activeProfileId) ?? store.profiles[0] ??
          null
        if (!active || !isTokenExpired(active.token, 0)) return
        const config = yield* loadOAuthConfig(storeName)
        if (!config) {
          return yield* Effect.fail(new MissingOAuthConfigError({ authStoreName: storeName, profileId: active.id }))
        }
        const refreshed = yield* refreshToken(active.token, config)
        yield* saveProfileToken(storeName, refreshed)
      }))
    return yield* inspectAllToolProfiles(tools)
  })
