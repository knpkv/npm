import { HubPaths } from "@knpkv/herdr-fleet"
import { Config, Effect, Option } from "effect"

/**
 * Where hostd reads its fleet configuration, and whether the operator named it. Only the default
 * location (`HubPaths.fleetConfig`) may fall back to a standalone hub; an explicit `FLEET_CONFIG_PATH`
 * with no file still fails.
 */
export const fleetConfigSource = Effect.gen(function*() {
  const explicit = yield* Config.option(Config.String("FLEET_CONFIG_PATH"))
  if (Option.isSome(explicit)) return { path: explicit.value, explicit: true }
  const paths = yield* HubPaths
  return { path: paths.fleetConfig, explicit: false }
})

/** The fleet configuration path alone, for callers that never fall back (relay, fleetctl). */
export const fleetConfigPath = fleetConfigSource.pipe(Effect.map((source) => source.path))
