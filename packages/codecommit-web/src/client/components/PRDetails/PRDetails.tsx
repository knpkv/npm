import { useAtomValue, useAtomSet } from "@effect-atom/atom-react"
import { useEffect, useMemo } from "react"
import { marked } from "marked"
import { selectedPrAtom, viewAtom } from "../../atoms/ui.js"
import { useTheme } from "../../theme/index.js"
import { formatDate } from "../../utils/date.js"
import { Badge } from "../Badge/index.js"
import styles from "./PRDetails.module.css"

export function PRDetails() {
  const { theme } = useTheme()
  const pr = useAtomValue(selectedPrAtom)
  const setView = useAtomSet(viewAtom)

  const descriptionHtml = useMemo(() => {
    if (!pr?.description) return ""
    return marked.parse(pr.description, { async: false }) as string
  }, [pr?.description])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        setView("prs")
      } else if (e.key === "Enter" || e.key === "o") {
        if (pr?.link) {
          window.open(pr.link, "_blank")
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [pr, setView])

  if (!pr) {
    return (
      <div className={styles.container} style={{ backgroundColor: theme.backgroundPanel }}>
        <div className={styles.empty} style={{ color: theme.textMuted }}>
          No PR selected
        </div>
      </div>
    )
  }

  const badge = !pr.isMergeable ? (
    <Badge variant="error">CONFLICT</Badge>
  ) : pr.isApproved ? (
    <Badge variant="success">APPROVED</Badge>
  ) : (
    <Badge variant="neutral">NOT APPROVED</Badge>
  )

  return (
    <div className={styles.container} style={{ backgroundColor: theme.backgroundPanel }}>
      <div className={styles.header}>
        <button
          className={styles.backButton}
          style={{ color: theme.primary }}
          onClick={() => setView("prs")}
        >
          ← Back
        </button>
        <button
          className={styles.openButton}
          style={{ backgroundColor: theme.primary, color: theme.background }}
          onClick={() => window.open(pr.link, "_blank")}
        >
          Open in Browser
        </button>
      </div>

      <div className={styles.content}>
        <div className={styles.row}>
          {badge}
          <span style={{ color: theme.textMuted, marginLeft: 8 }}>
            {pr.author} • {formatDate(pr.creationDate)}
          </span>
        </div>

        <h1 className={styles.title} style={{ color: theme.text }}>
          {pr.title}
        </h1>

        <div className={styles.meta}>
          <div className={styles.metaRow}>
            <span style={{ color: theme.textMuted }}>Repository:</span>
            <span style={{ color: theme.text }}>{pr.repositoryName}</span>
          </div>
          <div className={styles.metaRow}>
            <span style={{ color: theme.textMuted }}>Branch:</span>
            <span style={{ color: theme.primary }}>{pr.sourceBranch}</span>
            <span style={{ color: theme.textMuted }}> → </span>
            <span style={{ color: theme.primary }}>{pr.destinationBranch}</span>
          </div>
          <div className={styles.metaRow}>
            <span style={{ color: theme.textMuted }}>ID:</span>
            <span style={{ color: theme.text }}>{pr.id}</span>
          </div>
        </div>

        {pr.description && (
          <div className={styles.description}>
            <div style={{ color: theme.textMuted, marginBottom: 8 }}>Description:</div>
            <div
              className={styles.markdown}
              style={{ color: theme.text }}
              dangerouslySetInnerHTML={{ __html: descriptionHtml }}
            />
          </div>
        )}
      </div>
    </div>
  )
}
