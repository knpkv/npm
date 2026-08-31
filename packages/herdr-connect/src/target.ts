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

export type ConnectPreferenceResolution =
  | { readonly _tag: "resolved"; readonly target: ConnectAgent | null }
  | { readonly _tag: "retry"; readonly reason: "unknown" }
  | { readonly _tag: "rejected"; readonly reason: "malformed" }

export type RememberedConnectPreference =
  | { readonly _tag: "available"; readonly key: string | null }
  | { readonly _tag: "unavailable" }

export type ConnectPreferenceDecision =
  | { readonly _tag: "connect"; readonly target: ConnectAgent }
  | { readonly _tag: "retry"; readonly error: "connect_target.unknown"; readonly key: string | null }
  | { readonly _tag: "select"; readonly error: "connect_target.malformed" | null; readonly key: string | null }

export const resolveConnectPreference = Effect.fn("HerdrConnect.resolvePreference")(function*(
  search: string,
  agents: ReadonlyArray<ConnectAgent>
) {
  return yield* resolveConnectTarget(search, agents).pipe(
    Effect.map(
      (target): ConnectPreferenceResolution => ({ _tag: "resolved", target })
    ),
    Effect.catchTag("ConnectTargetError", (error) =>
      Effect.succeed<ConnectPreferenceResolution>(
        error.reason === "unknown"
          ? { _tag: "retry", reason: error.reason }
          : { _tag: "rejected", reason: error.reason }
      ))
  )
})

const connectPreferenceDecision = (
  resolution: ConnectPreferenceResolution,
  rememberedKey: string | null
): ConnectPreferenceDecision => {
  if (resolution._tag === "retry") {
    return {
      _tag: "retry",
      error: "connect_target.unknown",
      key: rememberedKey
    }
  }
  if (resolution._tag === "rejected") {
    return {
      _tag: "select",
      error: "connect_target.malformed",
      key: rememberedKey
    }
  }
  return resolution.target === null
    ? { _tag: "select", error: null, key: rememberedKey }
    : { _tag: "connect", target: resolution.target }
}

export const resolveConnectPreferenceDecision = Effect.fn("HerdrConnect.resolvePreferenceDecision")(function*(
  search: string,
  agents: ReadonlyArray<ConnectAgent>,
  remembered: RememberedConnectPreference
) {
  const rememberedKey = remembered._tag === "available" ? remembered.key : null
  const resolution = yield* resolveConnectPreference(search, agents)
  return connectPreferenceDecision(resolution, rememberedKey)
})
