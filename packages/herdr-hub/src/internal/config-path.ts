import { Config, Option } from "effect"

export const fleetConfigPath = Config.String("FLEET_CONFIG_PATH").pipe(
  Config.orElse(() =>
    Config.String("HOME").pipe(
      Config.map((home) => `${home}/.config/fleet/config.json`)
    )
  )
)

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
