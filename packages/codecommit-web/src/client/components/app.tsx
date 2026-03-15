import { useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import { useCallback } from "react"
import { Outlet, useLocation, useNavigate } from "react-router"
import { Toaster } from "sonner"
import { appStateAtom } from "../atoms/app.js"
import { useDesktopNotification } from "../hooks/useDesktopNotification.js"
import { useReviewReminder } from "../hooks/useReviewReminder.js"
import { useSSE } from "../hooks/useSSE.js"
import { useFullWidthRoute } from "../router.js"
import { CommandPalette } from "./command-palette.js"
import { FilterBar } from "./filter-bar.js"
import { Header } from "./header.js"
import { PermissionModal } from "./permission-modal.js"

export function AppLayout() {
  const setAppState = useAtomSet(appStateAtom)
  const state = useAtomValue(appStateAtom)
  const navigate = useNavigate()
  const goToNotifications = useCallback((path?: string) => navigate(path ?? "/notifications"), [navigate])
  const { notify } = useDesktopNotification((path) => navigate(path))
  useSSE((s) => setAppState(s), goToNotifications, notify)
  useReviewReminder(state.pendingReviewCount ?? 0)
  const { pathname } = useLocation()
  const isHome = pathname === "/"
  const isFullWidth = useFullWidthRoute()

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header />
      {isHome && <FilterBar />}
      <main className={isFullWidth ? "flex-1" : "mx-auto w-full max-w-5xl flex-1 px-4 py-6"}>
        <Outlet />
      </main>
      <CommandPalette />
      <Toaster />
      {state.permissionPrompt && <PermissionModal prompt={state.permissionPrompt} />}
    </div>
  )
}
