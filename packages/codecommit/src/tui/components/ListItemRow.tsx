import { parseColor } from "@opentui/core"
import { useTheme } from "../context/theme.js"
import type { ListItem } from "../ListBuilder.js"
import { DateUtils, type Domain } from "@knpkv/codecommit-core"
import { calculateHealthScore, getScoreTier, type HealthScore } from "@knpkv/codecommit-core/HealthScore.js"
import { Option } from "effect"
import { useMemo } from "react"
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
export function ListItemRow({ isFirst, item, selected }: ListItemRowProps) {
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
    return <PRItemRow pr={item.pr} bg={bg} fg={fg} />
  }

  return null
}

function PRItemRow({
  pr,
  bg,
  fg
}: {
  readonly pr: Domain.PullRequest
  readonly bg: string | undefined
  readonly fg: string
}) {
  const { theme } = useTheme()
  const score: HealthScore | undefined = useMemo(
    () => Option.getOrUndefined(calculateHealthScore(pr, new Date())),
    [pr]
  )
  const tier = score ? getScoreTier(score.total) : undefined
  const scoreColor =
    tier === "green"
      ? theme.success
      : tier === "yellow"
        ? theme.warning
        : tier === undefined
          ? theme.textMuted
          : theme.error

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
        <text fg={scoreColor}>{` ${score ? score.total.toFixed(1) : "---"} `}</text>
        <box style={{ flexGrow: 1 }} />
        {pr.commentCount !== undefined && pr.commentCount > 0 && (
          <text fg={theme.textMuted}>{`${pr.commentCount}c `}</text>
        )}
        <text fg={theme.textMuted}>{`${pr.author} • ${DateUtils.formatDate(pr.creationDate)}`}</text>
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
