/** Safe discovery and server-only loading of shared local Atlassian OAuth profiles. @module */

import { type AuthProfile, isTokenExpired, loadProfiles } from "@knpkv/atlassian-common/profile-storage"
import * as Effect from "effect/Effect"

import type { DiscoveredAtlassianProfile } from "../../../api/plugins.js"
import type { ProviderId } from "../../../domain/sourceRevision.js"

type AtlassianProviderId = Extract<ProviderId, "jira" | "confluence">

const profileStores: Readonly<Record<AtlassianProviderId, string>> = {
  jira: "jira-cli",
  confluence: "confluence-to-markdown"
}

interface ProfileWithProvider {
  readonly profile: AuthProfile
  readonly provider: AtlassianProviderId
}

const loadProviderProfiles = Effect.fn("AtlassianProfiles.loadProviderProfiles")(function*(
  provider: AtlassianProviderId
) {
  const store = yield* loadProfiles(profileStores[provider])
  return store.profiles.map((profile) => ({ profile, provider }))
})

/** Discover OAuth profile metadata without returning access or refresh tokens. */
export const discoverAtlassianProfiles = Effect.fn("AtlassianProfiles.discover")(function*() {
  const discovered = yield* Effect.all([
    loadProviderProfiles("jira"),
    loadProviderProfiles("confluence")
  ])
  const grouped = new Map<string, Array<ProfileWithProvider>>()
  for (const candidate of discovered.flat()) {
    const matches = grouped.get(candidate.profile.id) ?? []
    matches.push(candidate)
    grouped.set(candidate.profile.id, matches)
  }
  return [...grouped.values()].flatMap((matches): ReadonlyArray<DiscoveredAtlassianProfile> => {
    const first = matches[0]
    if (first === undefined) return []
    const { profile } = first
    const accountEmail = profile.token.user?.email?.trim()
    return [{
      profileId: profile.id,
      name: profile.name,
      siteUrl: profile.token.site_url,
      cloudId: profile.token.cloud_id,
      accountName: profile.token.user?.name ?? null,
      accountEmail: accountEmail === undefined || accountEmail.length === 0 ? null : accountEmail,
      status: matches.some(({ profile: match }) => isTokenExpired(match.token, 0)) ? "expired" : "valid",
      providers: matches.map(({ provider }) => provider)
    }]
  })
})

/** Load one selected OAuth profile inside the server runtime boundary. */
export const loadAtlassianProfile = Effect.fn("AtlassianProfiles.load")(function*(
  provider: AtlassianProviderId,
  profileId: string
) {
  const store = yield* loadProfiles(profileStores[provider])
  return store.profiles.find((candidate) => candidate.id === profileId) ?? null
})
