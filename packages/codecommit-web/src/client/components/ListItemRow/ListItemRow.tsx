import type { PullRequest } from "@knpkv/codecommit-core"
import { useTheme } from "../../theme/index.js"
import { formatDate } from "../../utils/date.js"
import { Badge } from "../Badge/index.js"
import styles from "./ListItemRow.module.css"

export type ListItem =
  | { type: "header"; label: string; count: number }
  | { type: "pr"; pr: PullRequest }
  | { type: "empty" }

interface ListItemRowProps {
  readonly item: ListItem
  readonly selected: boolean
  readonly onClick?: (() => void) | undefined
}

export function ListItemRow({ item, selected, onClick }: ListItemRowProps) {
  const { theme } = useTheme()

  if (item.type === "header") {
    return (
      <div className={styles.header} style={{ backgroundColor: theme.backgroundPanel }}>
        <span className={styles.headerLabel} style={{ color: theme.textWarning }}>
          {item.label.toUpperCase()}
        </span>
        {item.count > 0 && (
          <span className={styles.headerCount} style={{ color: theme.textMuted }}>
            ({item.count})
          </span>
        )}
      </div>
    )
  }

  if (item.type === "empty") {
    return (
      <div
        className={styles.empty}
        style={{
          borderLeftColor: theme.primary,
          color: theme.textMuted
        }}
      >
        (none)
      </div>
    )
  }

  if (item.type === "pr") {
    const pr = item.pr

    const badge = !pr.isMergeable ? (
      <Badge variant="error">CONFLICT</Badge>
    ) : pr.isApproved ? (
      <Badge variant="success">APPROVED</Badge>
    ) : (
      <Badge variant="neutral">NOT APPROVED</Badge>
    )

    const description = pr.description ? pr.description.split("\n").slice(0, 3).join("\n") : ""

    return (
      <div
        className={`${styles.pr} ${selected ? styles.selected : ""}`}
        data-selected={selected}
        style={{
          borderLeftColor: theme.primary,
          backgroundColor: selected ? theme.selectedBackground : undefined
        }}
        onClick={onClick}
      >
        <div className={styles.prHeader}>
          {badge}
          <span className={styles.prMeta} style={{ color: theme.textMuted }}>
            {pr.author} • {formatDate(pr.creationDate)}
          </span>
        </div>
        <div className={styles.prTitle}>
          <span style={{ color: selected ? theme.selectedText : theme.text }}>{pr.repositoryName}</span>
          <span style={{ color: theme.textMuted }}> › </span>
          <span style={{ color: selected ? theme.selectedText : theme.text }}>{pr.title}</span>
        </div>
        {description && (
          <div className={styles.prDescription} style={{ color: theme.textMuted }}>
            {description}
          </div>
        )}
      </div>
    )
  }

  return null
}
