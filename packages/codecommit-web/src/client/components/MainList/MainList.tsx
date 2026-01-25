import { Result, useAtomValue, useAtomSet } from "@effect-atom/atom-react"
import { Chunk } from "effect"
import { useMemo, useRef, useEffect, useCallback } from "react"
import type { PullRequest } from "@knpkv/codecommit-core"
import { prsQueryAtom, configQueryAtom } from "../../atoms/app.js"
import { filterTextAtom, selectedIndexAtom, selectedPrAtom } from "../../atoms/ui.js"
import { useTheme } from "../../theme/index.js"
import { ListItemRow, type ListItem } from "../ListItemRow/index.js"
import styles from "./MainList.module.css"

interface MainListProps {
  readonly onSelectPR?: (pr: PullRequest) => void
}

export function MainList({ onSelectPR }: MainListProps) {
  const { theme } = useTheme()
  const prsResult = useAtomValue(prsQueryAtom)
  const configResult = useAtomValue(configQueryAtom)
  const filterText = useAtomValue(filterTextAtom)
  const selectedIndex = useAtomValue(selectedIndexAtom)
  const setSelectedIndex = useAtomSet(selectedIndexAtom)
  const setSelectedPr = useAtomSet(selectedPrAtom)
  const scrollRef = useRef<HTMLDivElement>(null)

  const prs = Result.getOrElse(prsResult, () => Chunk.empty())
  const config = Result.getOrElse(configResult, () => ({ accounts: [] }))

  // Build list items grouped by account
  const items = useMemo(() => {
    const prArray = Chunk.toArray(prs)
    const accounts = config.accounts ?? []
    const enabledAccounts = accounts.filter((a: { enabled: boolean }) => a.enabled)

    if (enabledAccounts.length === 0 && prArray.length === 0) {
      return []
    }

    const result: ListItem[] = []

    // Group PRs by account
    const prsByAccount = new Map<string, PullRequest[]>()
    for (const pr of prArray) {
      const accountId = pr.account?.id ?? "unknown"
      if (!prsByAccount.has(accountId)) {
        prsByAccount.set(accountId, [])
      }
      prsByAccount.get(accountId)!.push(pr)
    }

    // Filter by text
    const filterLower = filterText.toLowerCase()
    const filterPR = (pr: PullRequest) => {
      if (!filterText) return true
      return (
        pr.repositoryName.toLowerCase().includes(filterLower) ||
        pr.title.toLowerCase().includes(filterLower) ||
        pr.author.toLowerCase().includes(filterLower) ||
        pr.sourceBranch.toLowerCase().includes(filterLower) ||
        (pr.description?.toLowerCase().includes(filterLower) ?? false)
      )
    }

    // Build items for each account
    for (const [accountId, accountPrs] of prsByAccount) {
      const filtered = accountPrs.filter(filterPR)
      result.push({ type: "header", label: accountId, count: filtered.length })
      if (filtered.length === 0) {
        result.push({ type: "empty" })
      } else {
        for (const pr of filtered) {
          result.push({ type: "pr", pr })
        }
      }
    }

    return result
  }, [prs, config, filterText])

  // Find next/prev PR index
  const findNextPrIndex = useCallback((from: number, direction: 1 | -1): number => {
    let idx = from + direction
    while (idx >= 0 && idx < items.length) {
      if (items[idx]?.type === "pr") return idx
      idx += direction
    }
    return from // stay at current if no PR found
  }, [items])

  // Find first PR index
  const firstPrIndex = useMemo(() => {
    return items.findIndex((item) => item.type === "pr")
  }, [items])

  // Initialize selection to first PR
  useEffect(() => {
    if (firstPrIndex >= 0 && selectedIndex === 0 && items[0]?.type !== "pr") {
      setSelectedIndex(firstPrIndex)
    }
  }, [firstPrIndex, selectedIndex, items, setSelectedIndex])

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return
      }

      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault()
        const next = findNextPrIndex(selectedIndex, 1)
        setSelectedIndex(next)
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault()
        const prev = findNextPrIndex(selectedIndex, -1)
        setSelectedIndex(prev)
      } else if (e.key === "Enter") {
        const item = items[selectedIndex]
        if (item?.type === "pr" && onSelectPR) {
          onSelectPR(item.pr)
        }
      } else if (e.key === "o") {
        // Open PR in browser
        const item = items[selectedIndex]
        if (item?.type === "pr" && item.pr.link) {
          window.open(item.pr.link, "_blank")
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [items, selectedIndex, setSelectedIndex, onSelectPR, findNextPrIndex])

  // Update selected PR atom when selection changes
  useEffect(() => {
    const item = items[selectedIndex]
    if (item?.type === "pr") {
      setSelectedPr(item.pr)
    }
  }, [items, selectedIndex, setSelectedPr])

  // Scroll selected item into view
  useEffect(() => {
    if (!scrollRef.current) return
    const selected = scrollRef.current.querySelector(`.${styles.selected}`)
    if (selected) {
      selected.scrollIntoView({ block: "nearest", behavior: "smooth" })
    }
  }, [selectedIndex])

  if (items.length === 0) {
    return (
      <div
        className={styles.empty}
        style={{ backgroundColor: theme.backgroundPanel, color: theme.textMuted }}
      >
        No items to display
      </div>
    )
  }

  return (
    <div
      ref={scrollRef}
      className={styles.list}
      style={{ backgroundColor: theme.backgroundPanel }}
    >
      {items.map((item, i) => (
        <ListItemRow
          key={i}
          item={item}
          selected={i === selectedIndex}
          onClick={() => {
            if (item.type === "pr") {
              setSelectedIndex(i)
              if (onSelectPR) onSelectPR(item.pr)
            }
          }}
        />
      ))}
    </div>
  )
}
