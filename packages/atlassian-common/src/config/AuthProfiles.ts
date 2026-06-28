/**
 * Multi-account/site auth profile storage for Atlassian CLIs.
 *
 * **Mental model**
 *
 * - `profiles.json` is the source of truth for multiple logged-in accounts/sites.
 * - The active profile is mirrored to the legacy `auth.json` token file so older
 *   single-profile consumers keep working.
 * - Existing single-token installs are treated as a one-profile store on read.
 *
 * @module
 */
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import type * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import {
  ensureConfigDir,
  getProfilesPath,
  type HomeDirectoryError,
  type HomeDirectoryTag,
  writeSecureFile
} from "./ConfigPaths.js"
import { type OAuthToken, OAuthTokenSchema } from "./OAuthSchemas.js"
import { deleteToken, FileSystemError, loadToken, saveToken } from "./TokenStorage.js"

/**
 * A persisted Atlassian auth profile.
 *
 * @category Schema
 */
export const AuthProfileSchema = Schema.Struct({
  /** Stable identifier derived from account and cloud IDs. */
  id: Schema.String,
  /** Human-readable profile label. */
  name: Schema.String,
  /** OAuth token and selected site metadata. */
  token: OAuthTokenSchema,
  /** ISO timestamp when the profile was first created. */
  created_at: Schema.String,
  /** ISO timestamp when the profile was last updated. */
  updated_at: Schema.String
})

/**
 * Type for a persisted Atlassian auth profile.
 *
 * @category Types
 */
export type AuthProfile = Schema.Schema.Type<typeof AuthProfileSchema>

/**
 * Schema for the profile registry file.
 *
 * @category Schema
 */
export const AuthProfilesFileSchema = Schema.Struct({
  /** Active profile ID. Omitted when no profile is active. */
  activeProfileId: Schema.optional(Schema.String),
  /** Known auth profiles for this CLI. */
  profiles: Schema.Array(AuthProfileSchema)
})

/**
 * Type for the profile registry file.
 *
 * @category Types
 */
export type AuthProfilesFile = Schema.Schema.Type<typeof AuthProfilesFileSchema>

const emptyProfiles = (): AuthProfilesFile => ({ profiles: [] })

const parseJsonOrNull = (content: string): unknown | null => {
  try {
    return JSON.parse(content) as unknown
  } catch {
    return null
  }
}

const hostFromUrl = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

const normalizeProfileIdPart = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")

/**
 * Build a stable profile ID from token site and user identity.
 *
 * @category Utilities
 */
export const profileIdFromToken = (token: OAuthToken): string => {
  const account = token.user?.account_id ? normalizeProfileIdPart(token.user.account_id) : "unknown-account"
  const site = normalizeProfileIdPart(token.cloud_id || hostFromUrl(token.site_url))
  return `${account}@${site}`
}

/**
 * Build a readable profile label from token site and user identity.
 *
 * @category Utilities
 */
export const profileNameFromToken = (token: OAuthToken): string => {
  const site = hostFromUrl(token.site_url)
  if (!token.user) return site
  const email = token.user.email.length > 0 ? ` (${token.user.email})` : ""
  return `${token.user.name}${email} @ ${site}`
}

/**
 * Create a profile record from an OAuth token.
 *
 * @category Utilities
 */
export const profileFromToken = (token: OAuthToken, now: Date): AuthProfile => {
  const timestamp = now.toISOString()
  return {
    id: profileIdFromToken(token),
    name: profileNameFromToken(token),
    token,
    created_at: timestamp,
    updated_at: timestamp
  }
}

const activeProfileFromStore = (store: AuthProfilesFile): AuthProfile | null => {
  if (store.profiles.length === 0) return null
  if (!store.activeProfileId) return store.profiles[0] ?? null
  return store.profiles.find((profile) => profile.id === store.activeProfileId) ?? store.profiles[0] ?? null
}

const storeFromLegacyToken = (token: OAuthToken | null, now: Date): AuthProfilesFile =>
  token === null
    ? emptyProfiles()
    : {
      activeProfileId: profileIdFromToken(token),
      profiles: [profileFromToken(token, now)]
    }

const readProfilesFile = (
  toolName: string
): Effect.Effect<
  AuthProfilesFile | null,
  FileSystemError | HomeDirectoryError,
  FileSystem.FileSystem | Path.Path | HomeDirectoryTag
> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const profilesPath = yield* getProfilesPath(toolName)

    const exists = yield* fs.exists(profilesPath).pipe(
      Effect.catch(() => Effect.succeed(false))
    )
    if (!exists) return null

    const content = yield* fs.readFileString(profilesPath).pipe(
      Effect.mapError((cause) => new FileSystemError({ operation: "read", path: profilesPath, cause }))
    )

    const parsed = parseJsonOrNull(content)
    if (parsed === null) {
      yield* Effect.logWarning(`Corrupted profiles.json at ${profilesPath} - could not parse JSON`)
      return null
    }

    return yield* Schema.decodeUnknownEffect(AuthProfilesFileSchema)(parsed).pipe(
      Effect.catch((e) =>
        Effect.logWarning(`Invalid profile schema in ${profilesPath}: ${e}`).pipe(
          Effect.map(() => null)
        )
      )
    )
  })

/**
 * Load all auth profiles for a tool.
 *
 * Falls back to the legacy single-token file when `profiles.json` does not exist.
 *
 * @category Profile Storage
 */
export const loadProfiles = (
  toolName: string
): Effect.Effect<
  AuthProfilesFile,
  FileSystemError | HomeDirectoryError,
  FileSystem.FileSystem | Path.Path | HomeDirectoryTag
> =>
  Effect.gen(function*() {
    const profiles = yield* readProfilesFile(toolName)
    if (profiles !== null) return profiles
    const legacyToken = yield* loadToken(toolName)
    const nowMs = yield* Clock.currentTimeMillis
    return storeFromLegacyToken(legacyToken, new Date(nowMs))
  })

/**
 * Save auth profiles and mirror the active profile to `auth.json`.
 *
 * @category Profile Storage
 */
export const saveProfiles = (
  toolName: string,
  store: AuthProfilesFile
) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* ensureConfigDir(toolName)
    const profilesPath = yield* getProfilesPath(toolName)
    const active = activeProfileFromStore(store)
    const normalized: AuthProfilesFile = {
      activeProfileId: active?.id,
      profiles: store.profiles
    }

    yield* writeSecureFile(profilesPath, JSON.stringify(normalized, null, 2)).pipe(
      Effect.provideService(FileSystem.FileSystem, fs)
    )

    if (active) {
      yield* saveToken(toolName, active.token)
    } else {
      yield* deleteToken(toolName)
    }
  })

/**
 * Insert or update a profile from a token and make it active.
 *
 * @category Profile Storage
 */
export const saveProfileToken = (
  toolName: string,
  token: OAuthToken
) =>
  Effect.gen(function*() {
    const store = yield* loadProfiles(toolName)
    const nowMs = yield* Clock.currentTimeMillis
    const next = profileFromToken(token, new Date(nowMs))
    const existing = store.profiles.find((profile) => profile.id === next.id)
    const profile: AuthProfile = existing
      ? { ...next, created_at: existing.created_at }
      : next
    const profiles = [
      profile,
      ...store.profiles.filter((stored) => stored.id !== profile.id)
    ]

    yield* saveProfiles(toolName, { activeProfileId: profile.id, profiles })
    return profile
  })

/**
 * Load the active auth profile.
 *
 * @category Profile Storage
 */
export const loadActiveProfile = (
  toolName: string
) =>
  loadProfiles(toolName).pipe(
    Effect.map(activeProfileFromStore)
  )

/**
 * Load the active OAuth token.
 *
 * @category Profile Storage
 */
export const loadActiveProfileToken = (
  toolName: string
) =>
  loadActiveProfile(toolName).pipe(
    Effect.map((profile) => profile?.token ?? null)
  )

/**
 * Set the active profile by ID.
 *
 * @category Profile Storage
 */
export const setActiveProfile = (
  toolName: string,
  profileId: string
) =>
  Effect.gen(function*() {
    const store = yield* loadProfiles(toolName)
    const profile = store.profiles.find((stored) => stored.id === profileId)
    if (!profile) return null
    yield* saveProfiles(toolName, { ...store, activeProfileId: profile.id })
    return profile
  })

/**
 * Resolve a profile by ID, name, site URL, cloud ID, or account ID.
 *
 * @category Utilities
 */
export const findProfile = (
  profiles: ReadonlyArray<AuthProfile>,
  selector: string
): AuthProfile | null =>
  profiles.find((profile) =>
    profile.id === selector ||
    profile.name === selector ||
    profile.token.site_url === selector ||
    profile.token.cloud_id === selector ||
    profile.token.user?.account_id === selector
  ) ?? null

/**
 * Set the active profile using a flexible selector.
 *
 * @category Profile Storage
 */
export const setActiveProfileBySelector = (
  toolName: string,
  selector: string
) =>
  Effect.gen(function*() {
    const store = yield* loadProfiles(toolName)
    const profile = findProfile(store.profiles, selector)
    if (!profile) return null
    yield* saveProfiles(toolName, { ...store, activeProfileId: profile.id })
    return profile
  })

/**
 * Remove a profile by ID.
 *
 * @category Profile Storage
 */
export const deleteProfile = (
  toolName: string,
  profileId: string
) =>
  Effect.gen(function*() {
    const store = yield* loadProfiles(toolName)
    const profile = store.profiles.find((stored) => stored.id === profileId)
    if (!profile) return null
    const profiles = store.profiles.filter((stored) => stored.id !== profile.id)
    const activeProfileId = store.activeProfileId === profile.id ? profiles[0]?.id : store.activeProfileId
    yield* saveProfiles(toolName, { activeProfileId, profiles })
    return profile
  })

/**
 * Remove a profile using a flexible selector.
 *
 * @category Profile Storage
 */
export const deleteProfileBySelector = (
  toolName: string,
  selector: string
) =>
  Effect.gen(function*() {
    const store = yield* loadProfiles(toolName)
    const profile = findProfile(store.profiles, selector)
    if (!profile) return null
    return yield* deleteProfile(toolName, profile.id)
  })

/**
 * Remove the active profile.
 *
 * @category Profile Storage
 */
export const deleteActiveProfile = (
  toolName: string
) =>
  Effect.gen(function*() {
    const active = yield* loadActiveProfile(toolName)
    if (!active) {
      yield* deleteToken(toolName)
      return null
    }
    return yield* deleteProfile(toolName, active.id)
  })
