import { useAtomValue } from "@effect/atom-react"
import { useMemo } from "react"
import { isSettingsFilteringAtom, settingsFilterAtom } from "../atoms/ui.js"
import { useTheme } from "../context/theme.js"
import type { ListItem } from "../ListBuilder.js"
import { Badge } from "./Badge.js"
import { type Column, Table } from "./Table.js"

interface SettingsAccountsTabProps {
  readonly items: ReadonlyArray<ListItem>
  readonly selectedIndex: number
}

export function SettingsAccountsTab({ items, selectedIndex }: SettingsAccountsTabProps) {
  const { theme } = useTheme()
  const settingsFilter = useAtomValue(settingsFilterAtom)
  const isFiltering = useAtomValue(isSettingsFilteringAtom)

  const { enabledCount, totalCount } = useMemo(() => {
    let enabled = 0
    let total = 0
    for (const item of items) {
      if (item.type === "account") {
        total++
        if (item.account.enabled) enabled++
      }
    }
    return { enabledCount: enabled, totalCount: total }
  }, [items])

  const columns: Array<Column<ListItem>> = [
    {
      header: "STATUS",
      width: 8,
      render: (item) => {
        if (item.type !== "account") return null
        return item.account.enabled ? (
          <Badge variant="success" minWidth={5}>
            ON
          </Badge>
        ) : (
          <Badge variant="neutral" minWidth={5}>
            OFF
          </Badge>
        )
      }
    },
    {
      header: "PROFILE",
      width: "auto",
      render: (item, selected) => {
        if (item.type !== "account") return null
        return <text fg={selected ? theme.selectedText : theme.text}>{item.account.profile}</text>
      }
    }
  ]

  return (
    <box style={{ flexDirection: "column", flexGrow: 1, width: "100%" }}>
      <Table
        data={items}
        columns={columns}
        selectedIndex={selectedIndex}
        keyExtractor={(i) => (i.type === "account" ? i.account.profile : "")}
      />
      <box
        style={{
          height: 1,
          width: "100%",
          backgroundColor: theme.backgroundPanel,
          flexDirection: "row",
          paddingLeft: 1
        }}
      >
        {isFiltering ? (
          <>
            <text fg={theme.textAccent} bg={theme.accentTint}>
              {" / "}
            </text>
            <text fg={theme.textMuted}>{" Filter accounts  "}</text>
            <text fg={theme.text}>{settingsFilter}</text>
            <text fg={theme.textAccent}>{"│"}</text>
          </>
        ) : (
          <>
            <text fg={theme.textMuted}>{`[←→] `}</text>
            {!settingsFilter.startsWith("on:") && !settingsFilter.startsWith("off:") ? (
              <text fg={theme.textAccent} bg={theme.accentTint}>
                {" all "}
              </text>
            ) : (
              <text fg={theme.textMuted}>{" all "}</text>
            )}
            {settingsFilter.startsWith("on:") ? (
              <text fg={theme.textAccent} bg={theme.accentTint}>
                {" on "}
              </text>
            ) : (
              <text fg={theme.textMuted}>{" on "}</text>
            )}
            {settingsFilter.startsWith("off:") ? (
              <text fg={theme.textAccent} bg={theme.accentTint}>
                {" off "}
              </text>
            ) : (
              <text fg={theme.textMuted}>{" off "}</text>
            )}
            <text fg={theme.textMuted}>{`  [/] Filter  [a] Enable  [d] Disable  `}</text>
            <text fg={theme.textAccent}>{`${enabledCount}/${totalCount}`}</text>
          </>
        )}
      </box>
    </box>
  )
}
