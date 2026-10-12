import type { PairSessionResponse } from "../api/session.js"

/**
 * Shape-only check, kept Schema-free so the eager entry stays small. It only decides whether to
 * route to pairing; the lazy pair route decodes the candidate as a `PairingCode` before any request.
 */
const BOOTSTRAP_CANDIDATE = /^[0-9a-f]{64}$/u

/** Read and erase the one-time fragment before constructing the router or rendering React. */
export const readBootstrapHandoff = (
  location: Pick<Location, "hash" | "search">,
  history: Pick<History, "replaceState">
): string | null => {
  if (!location.hash.startsWith("#bootstrap_token=")) return null
  const raw = location.hash.slice("#bootstrap_token=".length)
  history.replaceState(null, "", `/pair${location.search}`)
  return BOOTSTRAP_CANDIDATE.test(raw) ? raw : null
}

/** Transient credential handoff. Concurrent mounts share one POST; completed handoffs cannot replay. */
export interface BootstrapPairing {
  readonly pair: () => Promise<PairSessionResponse> | null
}

/** Keep the code only until the first exchange begins, outside storage and router history. */
export const makeBootstrapPairing = (
  code: string,
  exchange: (code: string) => Promise<PairSessionResponse> = (code) =>
    import("./PairPage.js").then((module) => module.exchangeBootstrapCode(code))
): BootstrapPairing => {
  let credential: string | null = code
  let pending: Promise<PairSessionResponse> | undefined
  let completed = false
  return {
    pair: () => {
      if (completed) return null
      if (pending !== undefined) return pending
      if (credential === null) return null
      const current = credential
      credential = null
      pending = exchange(current).then(
        (result) => {
          completed = true
          return result
        },
        (failure) => {
          completed = true
          throw failure
        }
      )
      return pending
    }
  }
}
