import { UsagePreset, UsageTimeZone } from "@knpkv/herdr-connect/usage"
import { FleetHostName } from "@knpkv/herdr-fleet/model"
import { DateTime, Option, Result, Schema } from "effect"

const NamedZone = UsageTimeZone.check(Schema.makeFilter((zone) => Option.isSome(DateTime.zoneMakeNamed(zone))))
const Query = Schema.fromURLSearchParams(Schema.Struct({
  range: Schema.optionalKey(UsagePreset),
  timeZone: Schema.optionalKey(NamedZone),
  host: Schema.optionalKey(FleetHostName)
}))
const RangeQuery = Schema.fromURLSearchParams(Schema.Struct({ range: Schema.optionalKey(UsagePreset) }))
const ZoneQuery = Schema.fromURLSearchParams(Schema.Struct({ timeZone: Schema.optionalKey(NamedZone) }))
const HostQuery = Schema.fromURLSearchParams(Schema.Struct({ host: Schema.optionalKey(FleetHostName) }))

export const UsageSelection = Schema.Struct({
  range: UsagePreset,
  timeZone: NamedZone,
  host: Schema.NullOr(FleetHostName)
})
export type UsageSelection = typeof UsageSelection.Type

export class UsageSelectionError extends Schema.TaggedError<UsageSelectionError>()("UsageSelectionError", {
  reason: Schema.Literal("invalid_default_time_zone")
}) {}

/**
 * The shell keeps selectors in the document query. Each invalid field resets independently;
 * valid fields survive repairs and unrelated selectors are removed. Only the active Usage page
 * may replace history with this result. A caller must supply a real named viewer zone.
 */
export const canonicalUsageSelection = (
  search: URLSearchParams,
  viewerTimeZone: string
): Result.Result<{
  readonly selection: UsageSelection
  readonly search: URLSearchParams
  readonly repaired: boolean
}, UsageSelectionError> => {
  const zone = Schema.decodeUnknownResult(NamedZone)(viewerTimeZone)
  if (Result.isFailure(zone)) return Result.fail(new UsageSelectionError({ reason: "invalid_default_time_zone" }))
  const decoded = Schema.decodeUnknownResult(Query, { onExcessProperty: "error" })(search)
  const range = Schema.decodeUnknownResult(RangeQuery)(search)
  const timeZone = Schema.decodeUnknownResult(ZoneQuery)(search)
  const host = Schema.decodeUnknownResult(HostQuery)(search)
  const selection: UsageSelection = Result.isSuccess(decoded)
    ? {
      range: decoded.success.range ?? "7d",
      timeZone: decoded.success.timeZone ?? zone.success,
      host: decoded.success.host ?? null
    }
    : {
      range: Result.isSuccess(range) ? range.success.range ?? "7d" : "7d",
      timeZone: Result.isSuccess(timeZone) ? timeZone.success.timeZone ?? zone.success : zone.success,
      host: Result.isSuccess(host) ? host.success.host ?? null : null
    }
  const canonical = new URLSearchParams({ range: selection.range, timeZone: selection.timeZone })
  if (selection.host !== null) canonical.set("host", selection.host)
  return Result.succeed({ selection, search: canonical, repaired: Result.isFailure(decoded) })
}
