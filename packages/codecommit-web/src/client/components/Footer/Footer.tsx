import { useAtomValue } from "@effect-atom/atom-react"
import { viewAtom, filterTextAtom, isFilteringAtom } from "../../atoms/ui.js"
import { HINTS } from "../../constants.js"
import { useTheme } from "../../theme/index.js"
import styles from "./Footer.module.css"

export function Footer() {
  const { theme } = useTheme()
  const view = useAtomValue(viewAtom)
  const filterText = useAtomValue(filterTextAtom)
  const isFiltering = useAtomValue(isFilteringAtom)

  if (isFiltering) {
    return (
      <footer className={styles.footer} style={{ backgroundColor: theme.backgroundElement }}>
        <span className={styles.filterLabel} style={{ backgroundColor: theme.primary, color: theme.background }}>
          /
        </span>
        <span style={{ color: theme.textMuted }}>Filter: </span>
        <span style={{ color: theme.text }}>{filterText}</span>
        <span className={styles.cursor} style={{ backgroundColor: theme.primary }} />
      </footer>
    )
  }

  const hintText = HINTS[view] || ""

  return (
    <footer className={styles.footer} style={{ backgroundColor: theme.backgroundPanel }}>
      <span style={{ color: theme.textMuted }}>&gt; {hintText}</span>
    </footer>
  )
}
