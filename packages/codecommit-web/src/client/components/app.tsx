import { useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import { appStateAtom } from "../atoms/app.js"
import { viewAtom } from "../atoms/ui.js"
import { useSSE } from "../hooks/useSSE.js"
import { CommandPalette } from "./command-palette.js"
import { FilterBar } from "./filter-bar.js"
import { Header } from "./header.js"
import { PRDetail } from "./pr-detail.js"
import { PRList } from "./pr-list.js"
import { ThemeProvider } from "./theme-provider.js"

function AppLayout() {
  const view = useAtomValue(viewAtom)
  const setAppState = useAtomSet(appStateAtom)
  useSSE((state) => setAppState(state))

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header />
      {view === "prs" && <FilterBar />}
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">
        {view === "prs" && <PRList />}
        {view === "details" && <PRDetail />}
      </main>
      <CommandPalette />
    </div>
  )
}

export function App() {
  return (
    <ThemeProvider>
      <AppLayout />
    </ThemeProvider>
  )
}
