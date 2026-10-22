import { Config, Option } from "effect"

/**
 * Where hostd reads its fleet configuration, and whether the operator named it. Only the default
 * location may fall back to a standalone hub; an explicit `FLEET_CONFIG_PATH` with no file still fails.
 */
export const fleetConfigSource = Config.option(Config.String("FLEET_CONFIG_PATH")).pipe(
  Config.flatMap(Option.match({
    onSome: (path) => Config.succeed({ path, explicit: true }),
    onNone: () =>
      Config.String("HOME").pipe(Config.map((home) => ({ path: `${home}/.config/fleet/config.json`, explicit: false })))
  }))
)

/** The fleet configuration path alone, for callers that never fall back (relay, fleetctl). */
export const fleetConfigPath = fleetConfigSource.pipe(Config.map((source) => source.path))
