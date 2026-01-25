import { parseColor } from "@opentui/core"
import { useTheme } from "../context/theme.js"
import type { ListItem } from "@knpkv/codecommit-core/ListBuilder"
import { formatDate } from "../utils/date.js"
import { Badge } from "./Badge.js"

interface ListItemRowProps {
  readonly item: ListItem
  readonly selected: boolean
  readonly isFirst?: boolean
}

/**
 * Renders a single row in the main PR list
 * @category components
 */
export function ListItemRow({ item, selected, isFirst }: ListItemRowProps) {
  const { theme } = useTheme()
  const bg = selected ? theme.selectedBackground : undefined
  const fg = selected ? theme.selectedText : theme.text

  if (item.type === "header") {
    return (
      <box
        style={{
          width: "100%",
          backgroundColor: theme.backgroundPanel,
          paddingLeft: 2,
          paddingTop: isFirst ? 0 : 1,
          flexDirection: "column"
        }}
      >
        <box
          border={["bottom"]}
          borderColor={theme.textMuted}
          style={{
            flexDirection: "row",
            paddingBottom: 1,
            width: "100%"
          }}
        >
          <text fg={theme.textWarning}>{item.label.toUpperCase()}</text>
          {item.count > 0 && <text fg={theme.textMuted}>{`(${item.count})`}</text>}
        </box>
      </box>
    )
  }

  if (item.type === "empty") {
    return (
      <box
        border={["left"]}
        borderColor={parseColor(theme.primary)}
        style={{
          width: "100%",
          paddingLeft: 4,
          paddingBottom: 1,
          flexDirection: "row",
          flexWrap: "no-wrap"
        }}
      >
        <text fg={theme.textMuted}>(none)</text>
      </box>
    )
  }

  if (item.type === "pr") {
    const pr = item.pr

    const badge = !pr.isMergeable ? (
      <Badge variant="error" minWidth={14}>
        CONFLICT
      </Badge>
    ) : pr.isApproved ? (
      <Badge variant="success" minWidth={14}>
        APPROVED
      </Badge>
    ) : (
      <Badge variant="neutral" minWidth={14}>
        NOT APPROVED
      </Badge>
    )

    const description = pr.description ? pr.description.split("\n").slice(0, 5).join("\n") : ""

    return (
      <box
        border={["left"]}
        borderColor={parseColor(theme.primary)}
        style={{
          width: "100%",
          ...(bg ? { backgroundColor: bg } : {}),
          paddingLeft: 2,
          paddingBottom: 1,
          marginBottom: 1,
          flexDirection: "column",
          flexWrap: "no-wrap"
        }}
      >
        <box style={{ flexDirection: "row", width: "100%", paddingBottom: 0 }}>
          {badge}
          <box style={{ flexGrow: 1 }} />
          <text fg={theme.textMuted}>{`${pr.author} • ${formatDate(pr.creationDate)}`}</text>
        </box>
        <box style={{ flexDirection: "row", width: "100%" }}>
          <text fg={fg}>{`${pr.repositoryName} `}</text>
          <text fg={theme.textMuted}>›</text>
          <text fg={fg}>{` ${pr.title}`}</text>
        </box>
        {description && (
          <text fg={theme.textMuted} style={{ paddingLeft: 0, paddingTop: 0 }}>
            {description}
          </text>
        )}
      </box>
    )
  }

  return null
}
