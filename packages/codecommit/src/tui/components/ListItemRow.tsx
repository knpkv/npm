import { DateUtils, type Domain } from "@knpkv/codecommit-core"
import { calculateHealthScore, getScoreTier, type HealthScore } from "@knpkv/codecommit-core/HealthScore.js"
import { parseColor } from "@opentui/core"
import { Option } from "effect"
import { useMemo } from "react"
import { useTheme } from "../context/theme.js"
import { terminalSafeCompactText } from "../details-model.js"
import type { ListItem } from "../ListBuilder.js"
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
          paddingLeft: 1,
          paddingTop: isFirst ? 0 : 1,
          flexDirection: "column"
        }}
      >
        <box
          border={["bottom"]}
          borderColor={theme.border}
          style={{
            flexDirection: "row",
            paddingBottom: 0,
            width: "100%"
          }}
        >
          <text fg={theme.textMuted}>{item.label.toUpperCase()}</text>
          {item.count > 0 && <text fg={theme.textMuted}>{`  ${item.count}`}</text>}
        </box>
      </box>
    )
  }

  if (item.type === "empty") {
    return (
      <box
        border={["left"]}
        borderColor={parseColor(theme.border)}
        style={{
          width: "100%",
          paddingLeft: 2,
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
  bg,
  fg,
  pr
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
    <Badge variant="error" minWidth={12}>
      CONFLICT
    </Badge>
  ) : pr.isApproved ? (
    <Badge variant="success" minWidth={12}>
      APPROVED
    </Badge>
  ) : (
    <Badge variant="neutral" minWidth={12}>
      PENDING
    </Badge>
  )

  const description =
    pr.description
      ?.split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ""
  const metadata = `${pr.sourceBranch} → ${pr.destinationBranch}  ·  ${pr.author}  ·  ${DateUtils.formatDate(pr.creationDate)}${
    pr.commentCount !== undefined && pr.commentCount > 0
      ? `  ·  ${pr.commentCount} comment${pr.commentCount === 1 ? "" : "s"}`
      : ""
  }`

  return (
    <box
      border={["left"]}
      borderColor={parseColor(bg ? theme.primary : theme.border)}
      style={{
        width: "100%",
        ...(bg ? { backgroundColor: bg } : {}),
        paddingLeft: 1,
        paddingTop: 0,
        paddingBottom: 0,
        flexDirection: "column",
        flexWrap: "no-wrap"
      }}
    >
      <box style={{ flexDirection: "row", width: "100%" }}>
        <text fg={theme.textAccent}>{`CODECOMMIT  PR #${pr.id}  `}</text>
        <text fg={theme.textMuted}>{terminalSafeCompactText(pr.repositoryName, 24)}</text>
        <box style={{ flexGrow: 1 }} />
        {badge}
        <text fg={scoreColor}>{`  health ${score ? score.total.toFixed(1) : "—"}`}</text>
      </box>
      <box style={{ flexDirection: "row", width: "100%" }}>
        <text fg={fg}>{terminalSafeCompactText(pr.title, 72)}</text>
      </box>
      <box style={{ flexDirection: "row", width: "100%" }}>
        <text fg={theme.textMuted}>{terminalSafeCompactText(metadata, 72)}</text>
      </box>
      {description && <text fg={theme.textMuted}>{terminalSafeCompactText(description, 72)}</text>}
    </box>
  )
}
