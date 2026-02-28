import { useAtomSet } from "@effect-atom/atom-react"
import { useCallback } from "react"
import { Outlet, useLocation, useNavigate } from "react-router"
import { Toaster } from "sonner"
import { appStateAtom } from "../atoms/app.js"
import { useSSE } from "../hooks/useSSE.js"
import { CommandPalette } from "./command-palette.js"
import { FilterBar } from "./filter-bar.js"
import { Header } from "./header.js"

export function AppLayout() {
  const setAppState = useAtomSet(appStateAtom)
  const navigate = useNavigate()
  const goToNotifications = useCallback(() => navigate("/notifications"), [navigate])
  useSSE((state) => setAppState(state), goToNotifications)
  const isHome = useLocation().pathname === "/"

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header />
      {isHome && <FilterBar />}
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">
        <Outlet />
      </main>
      <CommandPalette />
      <Toaster />
    </div>
  )
}
