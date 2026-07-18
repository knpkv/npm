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
