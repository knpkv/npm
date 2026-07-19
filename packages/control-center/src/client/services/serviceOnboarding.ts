import type { AtlassianOAuthProviderIntent } from "../../api/plugins.js"
import { firstPartyServiceIdentities } from "../../domain/firstPartyServices.js"
import type { ProviderId } from "../../domain/sourceRevision.js"

const providerFrom = (value: string | null): ProviderId | null =>
  firstPartyServiceIdentities.find(({ providerId }) => providerId === value)?.providerId ?? null

/** Pairing route that remembers which service the person chose to enable. */
export const servicePairingPath = (providerId: ProviderId): string => `/pair?service=${providerId}`

/** Service selected by an untrusted browser query parameter. */
export const selectedServiceProvider = (searchParams: URLSearchParams, key: "enable" | "service"): ProviderId | null =>
  providerFrom(searchParams.get(key))

/** Post-pairing destination that opens the selected service setup in place. */
export const serviceSetupPath = (providerId: ProviderId): string => `/services?enable=${providerId}`

/** Atlassian setup destination that preserves the initiating products and, when present, the completed profile. */
export const atlassianOAuthSetupPath = (
  providers: AtlassianOAuthProviderIntent,
  profileId: string | null = null
): string => {
  const searchParams = new URLSearchParams({ enable: providers.includes("jira") ? "jira" : "confluence" })
  if (profileId !== null) searchParams.set("atlassianProfile", profileId)
  for (const provider of providers) searchParams.append("atlassianProvider", provider)
  return `/services?${searchParams.toString()}`
}

/** Completed Atlassian profile selected by a bounded, untrusted browser query parameter. */
export const selectedAtlassianOAuthProfileId = (searchParams: URLSearchParams): string | null => {
  const profiles = searchParams.getAll("atlassianProfile")
  if (profiles.length !== 1) return null
  const [profileId] = profiles
  return profileId !== undefined && profileId.length > 0 && profileId.length <= 500 && profileId.trim() === profileId
    ? profileId
    : null
}

/** Atlassian product intent selected by repeated, untrusted browser query parameters. */
export const selectedAtlassianOAuthProviders = (
  searchParams: URLSearchParams
): AtlassianOAuthProviderIntent | null => {
  const providers = searchParams.getAll("atlassianProvider")
  if (providers.length === 1 && providers[0] === "jira") return ["jira"]
  if (providers.length === 1 && providers[0] === "confluence") return ["confluence"]
  if (providers.length === 2 && providers.includes("jira") && providers.includes("confluence")) {
    return ["jira", "confluence"]
  }
  return null
}
