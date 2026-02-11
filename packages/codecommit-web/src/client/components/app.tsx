import { useAtomSet } from "@effect-atom/atom-react"
import { Outlet, useLocation } from "react-router"
import { appStateAtom } from "../atoms/app.js"
import { useSSE } from "../hooks/useSSE.js"
import { CommandPalette } from "./command-palette.js"
import { FilterBar } from "./filter-bar.js"
import { Header } from "./header.js"

export function AppLayout() {
  const setAppState = useAtomSet(appStateAtom)
  useSSE((state) => setAppState(state))
  const isHome = useLocation().pathname === "/"

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header />
      {isHome && <FilterBar />}
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">
        <Outlet />
      </main>
      <CommandPalette />
    </div>
  )
}
