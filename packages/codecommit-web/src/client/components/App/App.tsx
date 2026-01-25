import { useAtomValue } from "@effect-atom/atom-react"
import { ThemeProvider, useTheme } from "../../theme/index.js"
import { Header } from "../Header/index.js"
import { FilterBar } from "../FilterBar/index.js"
import { MainList } from "../MainList/index.js"
import { PRDetails } from "../PRDetails/index.js"
import { StatusBar } from "../StatusBar/index.js"
import { CommandPalette } from "../CommandPalette/index.js"
import { viewAtom } from "../../atoms/ui.js"
import styles from "./App.module.css"

function AppLayout() {
  const { theme } = useTheme()
  const view = useAtomValue(viewAtom)

  return (
    <div className={styles.app} style={{ backgroundColor: theme.background }}>
      <Header />
      {view === "prs" && <FilterBar />}
      <main className={styles.main}>
        {view === "prs" && <MainList />}
        {view === "details" && <PRDetails />}
      </main>
      <StatusBar />
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
