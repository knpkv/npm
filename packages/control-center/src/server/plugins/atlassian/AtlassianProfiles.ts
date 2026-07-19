/** Safe discovery and server-only loading of shared local Atlassian OAuth profiles. @module */

import { CONFLUENCE_REQUIRED_SCOPES, JIRA_REQUIRED_SCOPES, missingScopes } from "@knpkv/atlassian-common/config"
import { type AuthProfile, isTokenExpired, loadProfiles } from "@knpkv/atlassian-common/profile-storage"
import * as Effect from "effect/Effect"

import type { DiscoveredAtlassianProfile } from "../../../api/plugins.js"
import type { ProviderId } from "../../../domain/sourceRevision.js"

type AtlassianProviderId = Extract<ProviderId, "jira" | "confluence">

/** Canonical credential store for OAuth grants created by Control Center. */
export const CONTROL_CENTER_AUTH_STORE_NAME = "control-center"

const legacyProfileStores: Readonly<Record<AtlassianProviderId, string>> = {
  jira: "jira-cli",
  confluence: "confluence-to-markdown"
}

const requiredScopes: Readonly<Record<AtlassianProviderId, ReadonlyArray<string>>> = {
  jira: JIRA_REQUIRED_SCOPES,
  confluence: CONFLUENCE_REQUIRED_SCOPES
}

const providers: ReadonlyArray<AtlassianProviderId> = ["jira", "confluence"]

const supportsProvider = (profile: AuthProfile, provider: AtlassianProviderId): boolean =>
  missingScopes(profile.token, requiredScopes[provider]).length === 0

const supportedProviders = (profile: AuthProfile): ReadonlyArray<AtlassianProviderId> =>
  providers.filter((provider) => supportsProvider(profile, provider))

const discoveredProfile = (
  profile: AuthProfile,
  profileId: string,
  intendedProviders: ReadonlyArray<AtlassianProviderId>
): DiscoveredAtlassianProfile => {
  const accountEmail = profile.token.user?.email?.trim()
  return {
    profileId,
    name: profile.name,
    siteUrl: profile.token.site_url,
    cloudId: profile.token.cloud_id,
    accountName: profile.token.user?.name ?? null,
    accountEmail: accountEmail === undefined || accountEmail.length === 0 ? null : accountEmail,
    status: isTokenExpired(profile.token, 0) ? "expired" : "valid",
    providers: intendedProviders
  }
}

const legacyProfileId = (provider: AtlassianProviderId, profileId: string): string => `legacy:${provider}:${profileId}`

const legacyProfileSelector = (
  profileId: string
): { readonly profileId: string; readonly provider: AtlassianProviderId } | null => {
  for (const provider of providers) {
    const prefix = `legacy:${provider}:`
    if (profileId.startsWith(prefix)) return { profileId: profileId.slice(prefix.length), provider }
  }
  return null
}

const loadProfile = Effect.fn("AtlassianProfiles.loadProfile")(function*(storeName: string, profileId: string) {
  const store = yield* loadProfiles(storeName)
  return store.profiles.find((candidate) => candidate.id === profileId) ?? null
})

/** Discover OAuth profile metadata without returning access or refresh tokens. */
export const discoverAtlassianProfiles = Effect.fn("AtlassianProfiles.discover")(function*() {
  const [canonical, jiraLegacy, confluenceLegacy] = yield* Effect.all([
    loadProfiles(CONTROL_CENTER_AUTH_STORE_NAME),
    loadProfiles(legacyProfileStores.jira),
    loadProfiles(legacyProfileStores.confluence)
  ])
  const canonicalProfiles = canonical.profiles.flatMap((profile): ReadonlyArray<DiscoveredAtlassianProfile> => {
    const supported = supportedProviders(profile)
    return supported.length === 0 ? [] : [discoveredProfile(profile, profile.id, supported)]
  })
  const legacyStores: ReadonlyArray<
    readonly [AtlassianProviderId, ReadonlyArray<AuthProfile>]
  > = [
    ["jira", jiraLegacy.profiles],
    ["confluence", confluenceLegacy.profiles]
  ]
  const legacyProfiles = legacyStores.flatMap(([provider, profiles]) =>
    profiles.flatMap((profile): ReadonlyArray<DiscoveredAtlassianProfile> =>
      supportsProvider(profile, provider)
        ? [discoveredProfile(profile, legacyProfileId(provider, profile.id), [provider])]
        : []
    )
  )
  return [...canonicalProfiles, ...legacyProfiles]
})

/** Load one selected OAuth profile inside the server runtime boundary. */
export const loadAtlassianProfile = Effect.fn("AtlassianProfiles.load")(function*(
  provider: AtlassianProviderId,
  profileId: string
) {
  const legacySelector = legacyProfileSelector(profileId)
  if (legacySelector !== null) {
    if (legacySelector.provider !== provider) return null
    const legacy = yield* loadProfile(legacyProfileStores[provider], legacySelector.profileId)
    return legacy !== null && supportsProvider(legacy, provider) ? legacy : null
  }

  const canonical = yield* loadProfile(CONTROL_CENTER_AUTH_STORE_NAME, profileId)
  if (canonical !== null && supportsProvider(canonical, provider) && !isTokenExpired(canonical.token, 0)) {
    return canonical
  }

  const legacy = yield* loadProfile(legacyProfileStores[provider], profileId)
  if (legacy !== null && supportsProvider(legacy, provider)) return legacy
  return canonical !== null && supportsProvider(canonical, provider) ? canonical : null
})
