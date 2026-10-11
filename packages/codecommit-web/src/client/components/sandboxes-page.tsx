import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { useNavigate } from "react-router"
import { appStateAtom, deleteSandboxAtom, restartSandboxAtom, stopSandboxAtom } from "../atoms/app.js"
import { SandboxesPageView } from "./sandboxes-page-view.js"

/** Inventory route wired to the application atom and router boundaries. */
export function SandboxesPage() {
  const state = useAtomValue(appStateAtom)
  const stopSandbox = useAtomSet(stopSandboxAtom)
  const restartSandbox = useAtomSet(restartSandboxAtom)
  const deleteSandbox = useAtomSet(deleteSandboxAtom)
  const navigate = useNavigate()
  return (
    <SandboxesPageView
      deleteSandbox={deleteSandbox}
      navigate={navigate}
      restartSandbox={restartSandbox}
      state={state}
      stopSandbox={stopSandbox}
    />
  )
}
