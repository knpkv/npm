/**
 * The browser's reads of the fleet's limits and usage, shared by Connect's limits line and the hub's
 * Usage tab: each GET, decoded at the boundary, stamped with when this page received it, and the
 * state a view needs (the last good read, and why the latest one failed).
 *
 * @module
 */
import { decodeBoundedResponseJson } from "@knpkv/herdr-fleet/response"
import { Clock, Effect, Option, Schema } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { type ConnectLimitsView, connectLimitsView } from "./limits-model.js"
import { FleetLimits } from "./limits.js"
import { type UsageTabView, usageTabView } from "./usage-model.js"
import { FleetUsage, type UsageQuery, usageResponseMaxBytes } from "./usage.js"

/** A fleet read could not be loaded: the request failed, the answer was not 2xx, or it did not decode. */
export class FleetReadLoadError extends Schema.TaggedError<FleetReadLoadError>()("FleetReadLoadError", {
  path: Schema.String,
  reason: Schema.Literals(["network", "status", "decode"]),
  cause: Schema.Defect()
}) {}

/** A fleet read and when this page received it, on this page's clock. */
export interface Received<A> {
  readonly fleet: A
  readonly receivedAt: number
}

const load = Effect.fn("FleetReads.load")(function*<A>(
  path: string,
  schema: Schema.Codec<A, unknown, never, never>,
  maxBytes?: number
) {
  const client = yield* HttpClient.HttpClient
  const response = yield* client.get(path).pipe(
    Effect.mapError((cause) => new FleetReadLoadError({ path, reason: "network", cause }))
  )
  if (response.status < 200 || response.status >= 300) {
    return yield* new FleetReadLoadError({ path, reason: "status", cause: response.status })
  }
  const fleet = yield* decodeBoundedResponseJson(response, schema, maxBytes).pipe(
    Effect.mapError((cause) => new FleetReadLoadError({ path, reason: "decode", cause }))
  )
  return { fleet, receivedAt: yield* Clock.currentTimeMillis } satisfies Received<A>
})

/** The fleet's limits: every host's latest windows. */
export const loadLimits = load("/v1/connect/limits", FleetLimits)

/** The fleet's usage for one range, in periods local to the asked zone. */
export const loadUsage = (query: UsageQuery) =>
  load(
    `/v1/connect/usage?${new URLSearchParams({ range: query.range, timeZone: query.timeZone }).toString()}`,
    FleetUsage,
    usageResponseMaxBytes
  )

/** What a view shows for the fleet's limits: the last good read's view, and why the latest load failed. */
export interface LimitsState {
  readonly problem: string | null
  readonly view: ConnectLimitsView | null
}

/** What the Usage tab shows: the last good read's view, whether a load is in flight, and why the latest failed. */
export interface UsageState {
  readonly problem: string | null
  readonly view: UsageTabView | null
  readonly loading: boolean
}

/**
 * The limits view as of the last good load, and why the latest load failed when it did. `now` is
 * this page's clock, compared only with when the page received the reads.
 */
export const limitsState = (
  result: AsyncResult.AsyncResult<Received<FleetLimits>, unknown>,
  now: number
): LimitsState => {
  const last = AsyncResult.value(result)
  return {
    problem: AsyncResult.isFailure(result) ? "Couldn't load limits. Trying again every minute." : null,
    view: Option.isSome(last) ? connectLimitsView(last.value.fleet, now - last.value.receivedAt) : null
  }
}

/** The Usage tab's view as of the last good load, whether a load is in flight, and why the latest failed. */
export const usageState = (
  result: AsyncResult.AsyncResult<Received<FleetUsage>, unknown>,
  now: number
): UsageState => {
  const last = AsyncResult.value(result)
  return {
    problem: AsyncResult.isFailure(result) ? "Couldn't load usage. Trying again in five minutes." : null,
    view: Option.isSome(last) ? usageTabView(last.value.fleet, now - last.value.receivedAt) : null,
    loading: result.waiting
  }
}
