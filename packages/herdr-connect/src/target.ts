import { Effect, Result, Schema } from "effect"
import { ConnectTargetError } from "./errors.js"
import { ConnectAgent } from "./model.js"

/**
 * A deep link to one agent: `?host=…&agent=…`, opening its terminal. `&open=stage` opens its stage instead,
 * as Work's link does, so the reader sees the agent before choosing the terminal.
 */
const ConnectTarget = Schema.Struct({
  agent: ConnectAgent.fields.id,
  host: ConnectAgent.fields.host,
  open: Schema.optional(Schema.Literal("stage"))
})

export type ConnectTargetSelection =
  | { readonly _tag: "absent" }
  | { readonly _tag: "malformed" }
  | {
    readonly _tag: "selected"
    readonly host: string
    readonly agent: ConnectAgent["id"]
    readonly open: "stage" | "terminal"
  }

/** Decode only the selection parameters, with case-insensitive hosts and exact agent ids. Other parameters do not select a new owner. */
export const connectTargetSelection = (search: string): ConnectTargetSelection => {
  const parameters = new URLSearchParams(search)
  const agent = parameters.getAll("agent")
  const host = parameters.getAll("host")
  const open = parameters.getAll("open")
  if (agent.length === 0 && host.length === 0) return { _tag: "absent" }
  if (agent.length !== 1 || host.length !== 1 || open.length > 1) return { _tag: "malformed" }
  const decoded = Schema.decodeUnknownResult(ConnectTarget)({ agent: agent[0], host: host[0], open: open[0] })
  if (Result.isFailure(decoded)) return { _tag: "malformed" }
  return {
    _tag: "selected",
    host: decoded.success.host.toLowerCase(),
    agent: decoded.success.agent,
    open: decoded.success.open ?? "terminal"
  }
}

/** Selection equality ignores unrelated query fields and host casing, but not the agent or opening mode. */
export const sameConnectTargetSelection = (left: ConnectTargetSelection, right: ConnectTargetSelection): boolean =>
  left._tag === "selected" && right._tag === "selected"
    ? left.host === right.host && left.agent === right.agent && left.open === right.open
    : left._tag === right._tag

/** Resolution and stage ownership share the same case-insensitive host match. Invalid selections never own an agent. */
export const connectTargetSelectionMatches = (
  selection: ConnectTargetSelection,
  agent: Pick<ConnectAgent, "host" | "id">,
  open?: "stage" | "terminal"
): boolean =>
  selection._tag === "selected" && selection.host === agent.host.toLowerCase() && selection.agent === agent.id &&
  (open === undefined || selection.open === open)

/** What a deep link opens: the agent's terminal, or its stage when the link says `open=stage`. */
export const connectTargetOpens = (search: string): "stage" | "terminal" =>
  new URLSearchParams(search).get("open") === "stage" ? "stage" : "terminal"

export const resolveConnectTarget = Effect.fn("HerdrConnect.resolveTarget")(function*(
  search: string,
  agents: ReadonlyArray<ConnectAgent>
) {
  const selection = connectTargetSelection(search)
  if (selection._tag === "absent") return null
  if (selection._tag === "malformed") return yield* new ConnectTargetError({ reason: "malformed" })
  const selected = agents.find((candidate) => connectTargetSelectionMatches(selection, candidate))
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
  | { readonly _tag: "stage"; readonly target: ConnectAgent }
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
  rememberedKey: string | null,
  opens: "stage" | "terminal"
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
    : { _tag: opens === "stage" ? "stage" : "connect", target: resolution.target }
}

export const resolveConnectPreferenceDecision = Effect.fn("HerdrConnect.resolvePreferenceDecision")(function*(
  search: string,
  agents: ReadonlyArray<ConnectAgent>,
  remembered: RememberedConnectPreference
) {
  const rememberedKey = remembered._tag === "available" ? remembered.key : null
  const resolution = yield* resolveConnectPreference(search, agents)
  return connectPreferenceDecision(resolution, rememberedKey, connectTargetOpens(search))
})
