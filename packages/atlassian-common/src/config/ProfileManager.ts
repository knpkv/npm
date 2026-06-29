/**
 * Unified Atlassian profile management helpers shared by Atlassian CLIs.
 *
 * @module
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import type * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import type { HttpClient } from "effect/unstable/http"
import type { OAuthError } from "../auth/OAuthErrors.js"
import { refreshToken } from "../auth/OAuthOperations.js"
import { type AuthProfile, findProfile, loadProfiles, saveProfiles, saveProfileToken } from "./AuthProfiles.js"
import { getProfilesPath, type HomeDirectoryError, type HomeDirectoryTag } from "./ConfigPaths.js"
import type { OAuthToken } from "./OAuthSchemas.js"
import { type FileSystemError, isTokenExpired, loadOAuthConfig } from "./TokenStorage.js"

export interface AtlassianToolDefinition {
  readonly toolName: string
  readonly authStoreName?: string
  readonly label: string
  readonly loginHint: string
  readonly requiredScopes: ReadonlyArray<string>
}

export const JIRA_REQUIRED_SCOPES = [
  "read:jira-work",
  "write:jira-work",
  "manage:jira-project",
  "read:jira-user",
  "read:me",
  "offline_access"
] as const

export const CONFLUENCE_REQUIRED_SCOPES = [
  "read:page:confluence",
  "write:page:confluence",
  "delete:page:confluence",
  "read:me",
  "offline_access"
] as const

export const ATLASSIAN_TOOLS = [
  {
    toolName: "jira-cli",
    label: "Jira CLI",
    loginHint: "jira auth login",
    requiredScopes: JIRA_REQUIRED_SCOPES
  },
  {
    toolName: "confluence-to-markdown",
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
] as const satisfies ReadonlyArray<AtlassianToolDefinition>

export type ProfileTokenStatus = "valid" | "expired"

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

const uniqueAuthTools = (tools: ReadonlyArray<AtlassianToolDefinition>): ReadonlyArray<AtlassianToolDefinition> =>
  tools.filter((tool, index) =>
    tools.findIndex((candidate) => authStoreName(candidate) === authStoreName(tool)) === index
  )

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

export const useProfileForAllTools = (
  selector: string,
  tools: ReadonlyArray<AtlassianToolDefinition> = ATLASSIAN_TOOLS
): Effect.Effect<
  ReadonlyArray<ToolProfileStatus>,
  FileSystemError | HomeDirectoryError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | HomeDirectoryTag
> =>
  Effect.gen(function*() {
    const authTools = uniqueAuthTools(tools)
    const stores = yield* Effect.forEach(authTools, (tool) =>
      loadProfiles(authStoreName(tool)).pipe(Effect.map((store) => [tool, store] as const)))
    const selected = stores.map(([, store]) =>
      findProfile(store.profiles, selector)
    ).find((profile): profile is AuthProfile =>
      profile !== null
    )
    if (!selected) return yield* inspectAllToolProfiles(tools)

    yield* Effect.forEach(stores, ([tool, store]) => {
      const matching = findProfile(store.profiles, selector) ?? findProfile(store.profiles, selected.id)
      if (!matching) return Effect.void
      return saveProfiles(authStoreName(tool), { ...store, activeProfileId: matching.id })
    })
    return yield* inspectAllToolProfiles(tools)
  })

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
        }
      }))
    return yield* inspectAllToolProfiles(tools)
  })

export const refreshActiveProfiles = (
  tools: ReadonlyArray<AtlassianToolDefinition> = ATLASSIAN_TOOLS
): Effect.Effect<
  ReadonlyArray<ToolProfileStatus>,
  OAuthError | FileSystemError | HomeDirectoryError | PlatformError.PlatformError,
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
        if (!config) return
        const refreshed = yield* refreshToken(active.token, config)
        yield* saveProfileToken(storeName, refreshed)
      }))
    return yield* inspectAllToolProfiles(tools)
  })
