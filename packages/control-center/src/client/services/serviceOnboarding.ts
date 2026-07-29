import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type { AtlassianOAuthProviderIntent } from "../../api/plugins.js"
import { firstPartyServiceIdentities } from "../../domain/firstPartyServices.js"
import { PluginConnectionId, type PluginConnectionId as PluginConnectionIdType } from "../../domain/identifiers.js"
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
  profileId: string | null = null,
  preferredSiteId: string | null = null
): string => {
  const searchParams = new URLSearchParams({ enable: providers.includes("jira") ? "jira" : "confluence" })
  if (profileId !== null) searchParams.set("atlassianProfile", profileId)
  if (preferredSiteId !== null) searchParams.set("atlassianSite", preferredSiteId)
  for (const provider of providers) searchParams.append("atlassianProvider", provider)
  return `/services?${searchParams.toString()}`
}

/** Post-callback destination that applies a new local OAuth profile to one existing connection. */
export const atlassianOAuthRecoveryPath = (
  pluginConnectionId: PluginConnectionIdType,
  profileId: string
): string => {
  const searchParams = new URLSearchParams({
    atlassianRecoveryConnection: pluginConnectionId,
    atlassianRecoveryProfile: profileId
  })
  return `/services?${searchParams.toString()}`
}

/** Existing connection selected for an exact OAuth recovery handoff. */
export const selectedAtlassianRecoveryConnectionId = (
  searchParams: URLSearchParams
): PluginConnectionIdType | null => {
  const values = searchParams.getAll("atlassianRecoveryConnection")
  if (values.length !== 1) return null
  const decoded = Schema.decodeUnknownResult(PluginConnectionId)(values[0])
  return Result.isSuccess(decoded) ? decoded.success : null
}

/** Completed local OAuth profile selected for an exact recovery handoff. */
export const selectedAtlassianRecoveryProfileId = (searchParams: URLSearchParams): string | null => {
  const values = searchParams.getAll("atlassianRecoveryProfile")
  if (values.length !== 1) return null
  const [value] = values
  return value !== undefined && value.length > 0 && value.length <= 500 && value.trim() === value
    ? value
    : null
}

/** Atlassian site pinned by a bounded, untrusted browser query parameter. */
export const selectedAtlassianOAuthSiteId = (searchParams: URLSearchParams): string | null => {
  const sites = searchParams.getAll("atlassianSite")
  if (sites.length !== 1) return null
  const [siteId] = sites
  return siteId !== undefined && siteId.length > 0 && siteId.length <= 512 && siteId.trim() === siteId ? siteId : null
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
