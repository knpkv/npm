import { Result, useAtomValue } from "@effect-atom/atom-react"
import { parseColor, SyntaxStyle } from "@opentui/core"
import { useEffect, useMemo, useState } from "react"
import { type AppState, appStateAtom } from "../atoms/app.js"
import { selectedPrIdAtom } from "../atoms/ui.js"
import { useTheme } from "../context/theme.js"
import { DateUtils } from "@knpkv/codecommit-core"
import { Badge } from "./Badge.js"
import { StatusRow } from "./StatusRow.js"

const defaultState: AppState = {
  status: "loading",
  pullRequests: [],
  accounts: []
}

/**
 * PR details view showing full PR information
 * @category components
 */
export function DetailsView() {
  const { theme } = useTheme()
  const selectedPrId = useAtomValue(selectedPrIdAtom)
  const appStateResult = useAtomValue(appStateAtom)
  const appState = Result.getOrElse(appStateResult, () => defaultState)

  // Find PR by ID directly - stable even when items reorder
  const pr = useMemo(() => {
    if (!selectedPrId) return null
    return appState.pullRequests.find((p) => p.id === selectedPrId) ?? null
  }, [selectedPrId, appState.pullRequests])
  const [syntaxStyle, setSyntaxStyle] = useState<SyntaxStyle | null>(null)

  useEffect(() => {
    const style = SyntaxStyle.fromStyles({
      default: { fg: parseColor(theme.markdownText) },
      "markup.heading": { fg: parseColor(theme.markdownHeading), bold: true },
      "markup.link": { fg: parseColor(theme.markdownLink), underline: true },
      "markup.link.label": { fg: parseColor(theme.markdownLinkText), underline: true },
      "markup.link.url": { fg: parseColor(theme.markdownLink), underline: true },
      "markup.raw": { fg: parseColor(theme.markdownCode) },
      "markup.quote": { fg: parseColor(theme.markdownBlockQuote), italic: true },
      "punctuation.special": { fg: parseColor(theme.markdownBlockQuote) },
      "markup.strong": { fg: parseColor(theme.markdownStrong), bold: true },
      "markup.bold": { fg: parseColor(theme.markdownStrong), bold: true },
      "markup.italic": { fg: parseColor(theme.markdownEmph), italic: true },
      "markup.list": { fg: parseColor(theme.markdownListItem) }
    })
    setSyntaxStyle(style)
    return () => style.destroy()
  }, [theme])

  if (!pr) {
    return (
      <box
        style={{
          flexGrow: 1,
          width: "100%",
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: theme.backgroundPanel
        }}
      >
        <text fg={theme.textMuted}>No PR selected</text>
      </box>
    )
  }

  return (
    <box
      style={{
        flexGrow: 1,
        width: "100%",
        flexDirection: "column",
        backgroundColor: theme.backgroundPanel
      }}
    >
      <box
        style={{
          height: 3,
          width: "100%",
          backgroundColor: theme.backgroundPanel,
          paddingLeft: 2,
          paddingRight: 2,
          justifyContent: "center",
          alignItems: "center"
        }}
      >
        <text fg={theme.textAccent}>{`  PR: ${pr.repositoryName} > ${pr.title}`}</text>
      </box>
      <scrollbox
        focused
        style={{
          flexGrow: 1,
          width: "100%",
          padding: 2,
          rootOptions: { backgroundColor: theme.backgroundPanel },
          viewportOptions: { backgroundColor: theme.backgroundPanel },
          contentOptions: { backgroundColor: theme.backgroundPanel }
        }}
      >
        <box flexDirection="column">
          <StatusRow label="Merge:">
            {!pr.isMergeable ? (
              <Badge variant="error" minWidth={14}>
                CONFLICT
              </Badge>
            ) : (
              <Badge variant="success" minWidth={14}>
                MERGEABLE
              </Badge>
            )}
          </StatusRow>
          <StatusRow label="Approval:">
            {pr.isApproved ? (
              <Badge variant="success" minWidth={14}>
                APPROVED
              </Badge>
            ) : (
              <Badge variant="neutral" minWidth={14}>
                PENDING
              </Badge>
            )}
          </StatusRow>
          <StatusRow label="State:">
            <text fg={theme.text}>{pr.status.toUpperCase()}</text>
          </StatusRow>

          <box style={{ height: 1 }} />

          <StatusRow label="Author:">
            <text fg={theme.text}>{pr.author}</text>
          </StatusRow>
          <StatusRow label="Created:">
            <text fg={theme.text}>{DateUtils.formatDateTime(pr.creationDate)}</text>
          </StatusRow>
          <StatusRow label="Branch:">
            <text fg={theme.text}>{`${pr.sourceBranch} -> ${pr.destinationBranch}`}</text>
          </StatusRow>

          <box style={{ height: 1 }} />
          <text fg={theme.textMuted}>{"\u2500".repeat(42)}</text>
          <box style={{ height: 1 }} />

          <text fg={theme.text}>DESCRIPTION</text>
          <box style={{ height: 1 }} />
          {syntaxStyle && (
            <markdown
              style={{ width: "100%" }}
              syntaxStyle={syntaxStyle}
              content={pr.description || "No description provided."}
            />
          )}

          <box style={{ height: 1 }} />

          <text fg={theme.text}>LINK</text>
          <text fg={theme.textAccent}>{`URL: ${pr.link}`}</text>
        </box>
      </scrollbox>
    </box>
  )
}
