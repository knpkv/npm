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
import { FilterSidebar } from "./filter-sidebar.js"
import { Header } from "./header.js"
import { PermissionModal } from "./permission-modal.js"
import { RecentActivity } from "./recent-activity.js"
import { SearchBar } from "./search-bar.js"

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
      {isHome ? (
        <div className="flex flex-1 gap-8 px-8 py-8">
          <FilterSidebar />
          <main className="flex-1 flex flex-col gap-6 min-w-0">
            <SearchBar />
            <Outlet />
          </main>
          {state.currentUser && (state.notifications?.items?.length ?? 0) > 0 && (
            <aside className="sticky top-20 w-64 shrink-0 self-start" style={{ maxHeight: "calc(100vh - 5rem)" }}>
              <RecentActivity notifications={state.notifications!.items} />
            </aside>
          )}
        </div>
      ) : (
        <main className={isFullWidth ? "flex-1" : "w-full flex-1 px-8 py-8"}>
          <Outlet />
        </main>
      )}
      <CommandPalette />
      <Toaster />
      {state.permissionPrompt && <PermissionModal prompt={state.permissionPrompt} />}
    </div>
  )
}
