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

/** Post-OAuth destination that preserves the products granted by the completed Atlassian profile. */
export const atlassianOAuthSetupPath = (providers: AtlassianOAuthProviderIntent): string => {
  const searchParams = new URLSearchParams({ enable: providers.includes("jira") ? "jira" : "confluence" })
  for (const provider of providers) searchParams.append("atlassianProvider", provider)
  return `/services?${searchParams.toString()}`
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
