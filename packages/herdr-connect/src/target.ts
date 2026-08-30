import { Effect, Schema } from "effect"
import { ConnectTargetError } from "./errors.js"
import { ConnectAgent } from "./model.js"

const ConnectTarget = Schema.Struct({
  agent: ConnectAgent.fields.id,
  host: ConnectAgent.fields.host
})

export const resolveConnectTarget = Effect.fn("HerdrConnect.resolveTarget")(function*(
  search: string,
  agents: ReadonlyArray<ConnectAgent>
) {
  const parameters = new URLSearchParams(search)
  const agent = parameters.getAll("agent")
  const host = parameters.getAll("host")
  if (agent.length === 0 && host.length === 0) return null
  if (agent.length !== 1 || host.length !== 1) {
    return yield* new ConnectTargetError({ reason: "malformed" })
  }
  const target = yield* Schema.decodeUnknownEffect(ConnectTarget)({
    agent: agent[0],
    host: host[0]
  }).pipe(
    Effect.mapError(() => new ConnectTargetError({ reason: "malformed" }))
  )
  const selected = agents.find(
    (candidate) =>
      candidate.id === target.agent &&
      candidate.host.toLowerCase() === target.host.toLowerCase()
  )
  return yield* selected === undefined
    ? new ConnectTargetError({ reason: "unknown" })
    : Effect.succeed(selected)
})
