import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { configQueryAtom, configSaveAtom } from "../atoms/app.js"
import { ConfigUnavailable } from "./load-failed.js"
import { SettingsSandboxView } from "./settings-sandbox-view.js"

export function SettingsSandbox() {
  const config = useAtomValue(configQueryAtom)
  const saveConfig = useAtomSet(configSaveAtom, { mode: "promise" })
  return (
    <SettingsSandboxView
      config={config}
      renderConfigUnavailable={() => <ConfigUnavailable />}
      saveConfig={saveConfig}
    />
  )
}
