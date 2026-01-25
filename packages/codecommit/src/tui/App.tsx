import { Result, useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import { useEffect } from "react"
import { createPrAtom, openPrAtom } from "./atoms/actions.js"
import { refreshAtom } from "./atoms/app.js"
import { creatingPrAtom, viewAtom } from "./atoms/ui.js"
import { DetailsView, Footer, Header, MainList, QuickFilters } from "./components/index.js"
import { DialogProvider } from "./context/dialog.js"
import { ThemeProvider } from "./context/theme.js"
import { useKeyboardNav } from "./hooks/useKeyboardNav.js"
import { DialogRenderer } from "./ui/Dialog.js"

interface AppProps {
  readonly onQuit: () => void
}

function AppContent({ onQuit }: AppProps) {
  const openPr = useAtomSet(openPrAtom)
  const refresh = useAtomSet(refreshAtom)
  const view = useAtomValue(viewAtom)
  const createPrResult = useAtomValue(createPrAtom)
  const setCreatingPr = useAtomSet(creatingPrAtom)

  // Trigger initial refresh
  useEffect(() => {
    refresh()
  }, [refresh])

  // Clear creating PR state when result comes in
  useEffect(() => {
    if (!Result.isInitial(createPrResult)) {
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
    <box style={{ flexDirection: "column", height: "100%", width: "100%" }}>
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
