import { Result, useAtomValue } from "@effect-atom/atom-react"
import { Chunk } from "effect"
import { prsQueryAtom } from "../../atoms/app.js"
import { viewAtom } from "../../atoms/ui.js"
import { useTheme } from "../../theme/index.js"
import styles from "./StatusBar.module.css"

export function StatusBar() {
  const { theme } = useTheme()
  const view = useAtomValue(viewAtom)
  const prsResult = useAtomValue(prsQueryAtom)

  const isLoading = Result.isInitial(prsResult) || Result.isWaiting(prsResult)
  const hasError = Result.isFailure(prsResult)
  const prs = Result.getOrElse(prsResult, () => Chunk.empty())
  const count = Chunk.size(prs)

  const statusText = isLoading
    ? "Loading..."
    : hasError
      ? "Error loading PRs"
      : `${count} pull request${count !== 1 ? "s" : ""}`

  const hints = view === "prs"
    ? "Click PR to view details • Ctrl+P Commands • Ctrl+F Filter"
    : "Esc Back • Click Open to view in browser"

  return (
    <footer className={styles.statusBar} style={{ backgroundColor: theme.backgroundElement }}>
      <div className={styles.left}>
        <span
          className={styles.status}
          style={{ color: hasError ? theme.textError : theme.textMuted }}
        >
          {statusText}
        </span>
      </div>
      <div className={styles.right}>
        <span style={{ color: theme.textMuted }}>{hints}</span>
      </div>
    </footer>
  )
}
