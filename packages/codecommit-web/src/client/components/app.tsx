import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { useCallback } from "react"
import { Outlet, ScrollRestoration, useNavigate } from "react-router"
import { Toaster } from "sonner"
import { appStateAtom } from "../atoms/app.js"
import { CodeCommitRelayDock } from "../codecommitRelayDock.js"
import { useDesktopNotification } from "../hooks/useDesktopNotification.js"
import { useReviewReminder } from "../hooks/useReviewReminder.js"
import { useSSE } from "../hooks/useSSE.js"
import { useFullWidthRoute } from "../router.js"
import { CommandPalette } from "./command-palette.js"
import { Header } from "./header.js"
import { PermissionModal } from "./permission-modal.js"
import styles from "./app.module.css"
import { useTheme } from "./theme-provider.js"

export function AppLayout() {
  const setAppState = useAtomSet(appStateAtom)
  const state = useAtomValue(appStateAtom)
  const navigate = useNavigate()
  const goToNotifications = useCallback((path?: string) => navigate(path ?? "/notifications"), [navigate])
  const { notify } = useDesktopNotification((path) => navigate(path))
  useSSE((s) => setAppState(s), goToNotifications, notify)
  useReviewReminder(state.pendingReviewCount ?? 0)
  const isFullWidth = useFullWidthRoute()
  const { theme } = useTheme()

  return (
    <CodeCommitRelayDock>
      <div className={`${styles.root} ${isFullWidth ? styles.fullWidthRoot : ""}`}>
        <Header />
        <main className={isFullWidth ? styles.fullWidthMain : styles.main}>
          <Outlet />
        </main>
        <ScrollRestoration storageKey="codecommit-web-scroll-positions" />
        <CommandPalette />
        <Toaster theme={theme} />
        {state.permissionPrompt && <PermissionModal prompt={state.permissionPrompt} />}
      </div>
    </CodeCommitRelayDock>
  )
}
