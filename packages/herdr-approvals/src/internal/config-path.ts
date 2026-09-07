import { Config } from "effect"

export const fleetConfigPath = Config.string("FLEET_CONFIG_PATH").pipe(
  Config.orElse(() =>
    Config.string("HOME").pipe(
      Config.map((home) => `${home}/.config/fleet/config.json`)
    )
  )
)
