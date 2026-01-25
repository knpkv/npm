import { Result, useAtomValue } from "@effect-atom/atom-react"
import { Chunk } from "effect"
import { useEffect, useState } from "react"
import { prsQueryAtom } from "../../atoms/app.js"
import { viewAtom } from "../../atoms/ui.js"
import { SPINNER_FRAMES, VIEW_TITLES } from "../../constants.js"
import { useTheme } from "../../theme/index.js"
import { formatRelativeTime } from "../../utils/date.js"
import styles from "./Header.module.css"

export function Header() {
  const { theme } = useTheme()
  const prsResult = useAtomValue(prsQueryAtom)
  const view = useAtomValue(viewAtom)
  const [, setTick] = useState(0)
  const [spinnerFrame, setSpinnerFrame] = useState(0)

  const isLoading = Result.isInitial(prsResult) || Result.isWaiting(prsResult)
  const prs = Result.getOrElse(prsResult, () => Chunk.empty())

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 10000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (isLoading) {
      const interval = setInterval(
        () => setSpinnerFrame((f) => (f + 1) % SPINNER_FRAMES.length),
        80
      )
      return () => clearInterval(interval)
    }
  }, [isLoading])

  const hasError = Result.isFailure(prsResult)
  if (hasError) {
    return (
      <header className={styles.header} style={{ backgroundColor: theme.backgroundHeaderError }}>
        <span className={styles.title} style={{ color: theme.text }}>
          [X] ERROR: Failed to load PRs
        </span>
      </header>
    )
  }

  const lastUpdateStr = isLoading
    ? `[@] Updating... ${SPINNER_FRAMES[spinnerFrame]}`
    : `[@] ${formatRelativeTime(new Date())}`

  const count = Chunk.size(prs)
  const title = (VIEW_TITLES[view] || "Web").toUpperCase()
  const headerText = `AWS ${title} (${count}) ${lastUpdateStr}`

  return (
    <header className={styles.header} style={{ backgroundColor: theme.backgroundHeader }}>
      <span className={styles.title} style={{ color: theme.text }}>
        {headerText}
      </span>
    </header>
  )
}
