import { useAtomSet, useAtomValue } from "@effect/atom-react"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import { useEffect } from "react"
import { createPrAtom, openPrAtom } from "./atoms/actions.js"
import { appStateAtom, refreshAtom } from "./atoms/app.js"
import { ambiguousMergeGuardAtom, creatingPrAtom, viewAtom } from "./atoms/ui.js"
import { DetailsView, Footer, Header, MainList, QuickFilters } from "./components/index.js"
import { DialogProvider } from "./context/dialog.js"
import { ThemeProvider, useTheme } from "./context/theme.js"
import { useKeyboardNav } from "./hooks/useKeyboardNav.js"
import { DialogRenderer } from "./ui/Dialog.js"
import { ambiguousMergeGuardAfterAppStatus } from "./details-model.js"

interface AppProps {
  readonly onQuit: () => void
}

function AppContent({ onQuit }: AppProps) {
  const { theme } = useTheme()
  const openPr = useAtomSet(openPrAtom)
  const refresh = useAtomSet(refreshAtom)
  const appStateResult = useAtomValue(appStateAtom)
  const ambiguousMergeGuard = useAtomValue(ambiguousMergeGuardAtom)
  const setAmbiguousMergeGuard = useAtomSet(ambiguousMergeGuardAtom)
  const view = useAtomValue(viewAtom)
  const createPrResult = useAtomValue(createPrAtom)
  const setCreatingPr = useAtomSet(creatingPrAtom)

  // Trigger initial refresh
  useEffect(() => {
    refresh()
  }, [refresh])

  // A merge with an unknown provider outcome stays locked across DetailsView
  // unmounts. Only a later completed authoritative refresh clears it.
  useEffect(() => {
    if (ambiguousMergeGuard === null || !AsyncResult.isSuccess(appStateResult)) return
    const next = ambiguousMergeGuardAfterAppStatus(
      ambiguousMergeGuard,
      appStateResult.value.status,
      appStateResult.value.lastUpdated,
      appStateResult.value.successfulRefreshScopes
    )
    if (next !== ambiguousMergeGuard) setAmbiguousMergeGuard(next)
  }, [ambiguousMergeGuard, appStateResult, setAmbiguousMergeGuard])

  // Clear creating PR state when result comes in
  useEffect(() => {
    if (!AsyncResult.isInitial(createPrResult)) {
      setCreatingPr(null)
    }
  }, [createPrResult, setCreatingPr])

  // Initialize keyboard navigation and global shortcuts
  useKeyboardNav({
    onQuit,
    onOpenInBrowser: (pr) => {
      openPr(pr)
    }
  })

  return (
    <box style={{ backgroundColor: theme.background, flexDirection: "column", height: "100%", width: "100%" }}>
      <Header />

      <box style={{ flexGrow: 1, width: "100%" }}>
        <MainList />
        {view === "details" && (
          <box style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}>
            <DetailsView />
          </box>
        )}
      </box>

      {view === "prs" && <QuickFilters />}
      <Footer />

      {/* Overlay layer for dialogs */}
      <DialogRenderer />
    </box>
  )
}

export function App({ onQuit }: AppProps) {
  return (
    <ThemeProvider>
      <DialogProvider>
        <AppContent onQuit={onQuit} />
      </DialogProvider>
    </ThemeProvider>
  )
}
