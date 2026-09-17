import { Crypto, Effect, Encoding } from "effect"
import { FleetOperationError } from "./errors.js"
import type { JobPayload } from "./model.js"

const text = (value: string): string => JSON.stringify(value)

const canonicalPayload = (payload: JobPayload): string => {
  switch (payload.kind) {
    case "browser.mcp.recover":
      return `{"kind":${text(payload.kind)}}`
    case "nix.check":
      return `{"kind":${text(payload.kind)}}`
    case "nix.apply":
      return `{"kind":${text(payload.kind)},"ref":${text(payload.ref)}}`
    case "agent.delegate":
      return `{"channel":${payload.channel === undefined ? "null" : text(payload.channel)},"kind":${
        text(payload.kind)
      },"mode":${text(payload.mode)},"prompt":${text(payload.prompt)},"repository":${text(payload.repository)}}`
    case "agent.message":
      return `{"kind":${text(payload.kind)},"message":${text(payload.message)},"session":${text(payload.session)}}`
  }
}

export const jobHash = Effect.fn("Fleet.jobHash")(function*(
  host: string,
  actor: string,
  payload: JobPayload
) {
  const cryptoService = yield* Crypto.Crypto
  const canonical = `{"actor":${text(actor)},"host":${text(host)},"payload":${canonicalPayload(payload)}}`
  const digest = yield* cryptoService.digest("SHA-256", new TextEncoder().encode(canonical)).pipe(
    Effect.mapError(
      (cause) =>
        new FleetOperationError({
          cause,
          detail: "could not hash fleet job payload",
          operation: "fleet.job_hash"
        })
    )
  )
  return Encoding.encodeHex(digest)
})
