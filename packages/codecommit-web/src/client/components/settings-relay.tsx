/** Relay settings route wired to the application atoms. @module */
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { useNavigate } from "react-router"
import { configQueryAtom, configSaveAtom, reviewSkillsQueryAtom } from "../atoms/app.js"
import { SettingsRelayView } from "./settings-relay-view.js"

export function SettingsRelay() {
  const config = useAtomValue(configQueryAtom)
  const skills = useAtomValue(reviewSkillsQueryAtom)
  const saveConfig = useAtomSet(configSaveAtom, { mode: "promiseExit" })
  const navigate = useNavigate()
  return <SettingsRelayView config={config} onReload={() => void navigate(0)} saveConfig={saveConfig} skills={skills} />
}
