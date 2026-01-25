import { ThemeProvider, useTheme } from "../../theme/index.js"
import { Header } from "../Header/index.js"
import { Footer } from "../Footer/index.js"
import { MainList } from "../MainList/index.js"
import styles from "./App.module.css"

function AppLayout() {
  const { theme } = useTheme()

  return (
    <div className={styles.app} style={{ backgroundColor: theme.background }}>
      <Header />
      <main className={styles.main}>
        <MainList />
      </main>
      <Footer />
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
