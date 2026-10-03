import { Config } from "effect"

export const fleetConfigPath = Config.String("FLEET_CONFIG_PATH").pipe(
  Config.orElse(() =>
    Config.String("HOME").pipe(
      Config.map((home) => `${home}/.config/fleet/config.json`)
    )
  )
)
