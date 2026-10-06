import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { useCallback, useMemo } from "react"
import { Outlet, ScrollRestoration, useNavigate } from "react-router"
import { Toaster } from "sonner"
import { appStateAtom } from "../atoms/app.js"
import { CodeCommitRelayDock } from "../codecommitRelayDock.js"
import { useDesktopNotification } from "../hooks/useDesktopNotification.js"
import { useReviewReminder } from "../hooks/useReviewReminder.js"
import { useSSE } from "../hooks/useSSE.js"
import { useFullWidthRoute, useWideRoute } from "../router.js"
import { queuePullRequests } from "../utils/queuePullRequests.js"
import { CommandPalette } from "./command-palette.js"
import { Header } from "./header.js"
import { PermissionModal } from "./permission-modal.js"
import styles from "./app.module.css"
import { useTheme } from "./theme-provider.js"
import { callerOf, yourReviewCount } from "./workbench-queue.js"

export function AppLayout() {
  const setAppState = useAtomSet(appStateAtom)
  const state = useAtomValue(appStateAtom)
  const navigate = useNavigate()
  const goToNotifications = useCallback((path?: string) => navigate(path ?? "/notifications"), [navigate])
  const { notify } = useDesktopNotification((path) => navigate(path))
  useSSE((s) => setAppState(s), goToNotifications, notify)
  const reviewCount = useMemo(() => yourReviewCount(queuePullRequests(state), callerOf(state)), [state])
  useReviewReminder(reviewCount)
  const isFullWidth = useFullWidthRoute()
  const isWide = useWideRoute()
  const { theme } = useTheme()

  return (
    <CodeCommitRelayDock>
      <div className={`${styles.root} ${isFullWidth ? styles.fullWidthRoot : ""}`}>
        <Header />
        <main
          className={isFullWidth ? styles.fullWidthMain : isWide ? `${styles.main} ${styles.wideMain}` : styles.main}
        >
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
