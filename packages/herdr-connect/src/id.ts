import { Crypto, Effect } from "effect"
import { Base64Url } from "effect/encoding"
import { ConnectAgentIdError } from "./errors.js"

export const connectAgentId = Effect.fn("HerdrConnect.agentId")(function*(
  host: string,
  paneId: string
) {
  const cryptoService = yield* Crypto.Crypto
  const digest = yield* cryptoService
    .digest(
      "SHA-256",
      new TextEncoder().encode(`${host.toLowerCase()}\0${paneId}`)
    )
    .pipe(Effect.mapError((cause) => new ConnectAgentIdError({ cause })))
  return `agent-${Base64Url.encode(digest)}`
})
