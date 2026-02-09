import { Result, useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import type { Domain } from "@knpkv/codecommit-core"
import { useKeyboard } from "@opentui/react"
import { useEffect, useMemo, useRef } from "react"
import { loginToAwsAtom } from "../atoms/actions.js"
import {
  appStateAtom,
  clearNotificationsAtom,
  notificationsAtom,
  refreshAtom,
  setAllAccountsAtom
} from "../atoms/app.js"
import {
  currentPRAtom,
  currentUserAtom,
  exitPendingAtom,
  filterTextAtom,
  isFilteringAtom,
  isSettingsFilteringAtom,
  quickFilterTypeAtom,
  quickFilterValuesAtom,
  selectedIndexAtom,
  settingsFilterAtom,
  SettingsTabs,
  settingsTabAtom,
  showDetailsCommentsAtom,
  themeAtom,
  themeSelectionIndexAtom,
  viewAtom
} from "../atoms/ui.js"
import { useDialog } from "../context/dialog.js"
import { extractScope } from "../ListBuilder.js"
import { themes } from "../theme/themes.js"
import { DialogCommand } from "../ui/DialogCommand.js"

const defaultState: Domain.AppState = {
  status: "loading",
  pullRequests: [],
  accounts: []
}

interface UseKeyboardNavOptions {
  readonly onQuit: () => void
  readonly onOpenInBrowser?: (pr: Domain.PullRequest) => void
}

/**
 * Keyboard navigation hook for the TUI
 * @category hooks
 */
export function useKeyboardNav({ onOpenInBrowser, onQuit }: UseKeyboardNavOptions) {
  const view = useAtomValue(viewAtom)
  const setView = useAtomSet(viewAtom)
  const filterText = useAtomValue(filterTextAtom)
  const setFilterText = useAtomSet(filterTextAtom)
  const isFiltering = useAtomValue(isFilteringAtom)
  const setIsFiltering = useAtomSet(isFilteringAtom)
  const currentPR = useAtomValue(currentPRAtom)
  const selectedIndex = useAtomValue(selectedIndexAtom)
  const refresh = useAtomSet(refreshAtom)
  const clearNotifications = useAtomSet(clearNotificationsAtom)
  const notificationsResult = useAtomValue(notificationsAtom)
  const notifications = Result.getOrElse(notificationsResult, () => ({ items: [] }))
  const loginToAws = useAtomSet(loginToAwsAtom)
  const exitPending = useAtomValue(exitPendingAtom)
  const setExitPending = useAtomSet(exitPendingAtom)
  const exitTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(
    () => () => {
      if (exitTimeoutRef.current) clearTimeout(exitTimeoutRef.current)
    },
    []
  )

  // Quick filter state
  const quickFilterType = useAtomValue(quickFilterTypeAtom)
  const setQuickFilterType = useAtomSet(quickFilterTypeAtom)
  const quickFilterValues = useAtomValue(quickFilterValuesAtom)
  const setQuickFilterValues = useAtomSet(quickFilterValuesAtom)
  const currentUser = useAtomValue(currentUserAtom)
  const setCurrentUser = useAtomSet(currentUserAtom)
  const appStateResult = useAtomValue(appStateAtom)
  const appState = Result.getOrElse(appStateResult, () => defaultState)

  // Settings state
  const settingsFilter = useAtomValue(settingsFilterAtom)
  const setSettingsFilter = useAtomSet(settingsFilterAtom)
  const isSettingsFiltering = useAtomValue(isSettingsFilteringAtom)
  const setIsSettingsFiltering = useAtomSet(isSettingsFilteringAtom)
  const setAllAccounts = useAtomSet(setAllAccountsAtom)
  const showDetailsComments = useAtomValue(showDetailsCommentsAtom)
  const setShowDetailsComments = useAtomSet(showDetailsCommentsAtom)
  const settingsTab = useAtomValue(settingsTabAtom)
  const setSettingsTab = useAtomSet(settingsTabAtom)
  const themeSelectionIndex = useAtomValue(themeSelectionIndexAtom)
  const setThemeSelectionIndex = useAtomSet(themeSelectionIndexAtom)
  const setThemeId = useAtomSet(themeAtom)
  const themeNames = useMemo(() => Object.keys(themes).sort(), [])

  // Extract unique authors, accounts, scopes, and repos
  const { accounts, authors, myScopes, repos, scopes } = useMemo(() => {
    const authorSet = new Set<string>()
    const accountSet = new Set<string>()
    const scopeSet = new Set<string>()
    const myScopeSet = new Set<string>()
    const repoSet = new Set<string>()
    for (const pr of appState.pullRequests) {
      authorSet.add(pr.author)
      accountSet.add(pr.account.id)
      repoSet.add(pr.repositoryName)
      const scope = extractScope(pr.title)
      if (scope) {
        scopeSet.add(scope)
        if (currentUser && pr.author === currentUser) {
          myScopeSet.add(scope)
        }
      }
    }
    return {
      authors: Array.from(authorSet).sort(),
      accounts: Array.from(accountSet).sort(),
      scopes: Array.from(scopeSet).sort(),
      myScopes: Array.from(myScopeSet).sort(),
      repos: Array.from(repoSet).sort()
    }
  }, [appState.pullRequests, currentUser])

  // Sync currentUser from appState
  useEffect(() => {
    if (appState.currentUser && appState.currentUser !== currentUser) {
      setCurrentUser(appState.currentUser)
    }
  }, [appState.currentUser, currentUser, setCurrentUser])

  const dialog = useDialog()

  useKeyboard((key: { name: string; ctrl?: boolean; meta?: boolean; char?: string }) => {
    // If a dialog is open, don't process global keys
    if (dialog.current) {
      return
    }

    // Command palette: Ctrl+P, Cmd+P, ":"
    if ((key.name === "p" && (key.meta || key.ctrl)) || key.char === ":" || key.name === ":") {
      dialog.show(() => <DialogCommand />)
      return
    }

    // Ctrl+C double-press to exit
    if (key.name === "c" && key.ctrl) {
      if (exitPending) {
        onQuit()
      } else {
        setExitPending(true)
        if (exitTimeoutRef.current) clearTimeout(exitTimeoutRef.current)
        exitTimeoutRef.current = setTimeout(() => {
          setExitPending(false)
        }, 3000)
      }
      return
    }

    // Filter mode input (PRs)
    if (isFiltering) {
      if (key.name === "escape") {
        setIsFiltering(false)
        setFilterText("")
      } else if (key.name === "return") {
        setIsFiltering(false)
      } else if (key.name === "backspace") {
        setFilterText(filterText.slice(0, -1))
      } else {
        const char = key.char || (key.name?.length === 1 ? key.name : null)
        if (char && char.length === 1) {
          setFilterText(filterText + char)
        }
      }
      return
    }

    // Settings filter mode input
    if (isSettingsFiltering) {
      if (key.name === "escape") {
        setIsSettingsFiltering(false)
        setSettingsFilter("")
      } else if (key.name === "return") {
        setIsSettingsFiltering(false)
      } else if (key.name === "backspace") {
        setSettingsFilter(settingsFilter.slice(0, -1))
      } else if (key.name === "left" || key.name === "right") {
        const modes = ["", "on:", "off:"] as const
        const currentPrefix = settingsFilter.startsWith("on:") ? "on:" : settingsFilter.startsWith("off:") ? "off:" : ""
        const nameFilter = currentPrefix ? settingsFilter.slice(currentPrefix.length) : settingsFilter
        const idx = modes.indexOf(currentPrefix)
        const nextIdx = key.name === "right" ? (idx + 1) % modes.length : (idx - 1 + modes.length) % modes.length
        const nextMode = modes[nextIdx] ?? ""
        setSettingsFilter(nextMode + nameFilter)
        return
      } else {
        const char = key.char || (key.name?.length === 1 ? key.name : null)
        if (char && char.length === 1) {
          setSettingsFilter(settingsFilter + char)
        }
      }
      return
    }

    // "/" or "f" filter shortcut
    if (key.name === "/" || key.char === "/" || key.name === "f") {
      if (view === "settings" && settingsTab === "accounts") {
        setIsSettingsFiltering(true)
      } else if (view !== "settings") {
        setIsFiltering(true)
        setView("prs")
      }
      return
    }

    // Settings view keybindings
    if (view === "settings") {
      // Tab: cycle settings tabs
      if (key.name === "tab") {
        const idx = SettingsTabs.indexOf(settingsTab)
        const next = SettingsTabs[(idx + 1) % SettingsTabs.length]!
        setSettingsTab(next)
        return
      }

      // 1-4: jump to settings tab
      if (key.name === "1") {
        setSettingsTab("accounts")
        return
      }
      if (key.name === "2") {
        setSettingsTab("theme")
        return
      }
      if (key.name === "3") {
        setSettingsTab("config")
        return
      }
      if (key.name === "4") {
        setSettingsTab("about")
        return
      }

      // Theme tab: up/down to navigate, enter to select
      if (settingsTab === "theme") {
        if (key.name === "up") {
          setThemeSelectionIndex(Math.max(0, themeSelectionIndex - 1))
          return
        }
        if (key.name === "down") {
          setThemeSelectionIndex(Math.min(themeNames.length - 1, themeSelectionIndex + 1))
          return
        }
        if (key.name === "return") {
          const selected = themeNames[themeSelectionIndex]
          if (selected) setThemeId(selected)
          return
        }
      }

      // Accounts tab specific
      if (settingsTab === "accounts") {
        if (key.name === "a") {
          const profiles = settingsFilter
            ? appState.accounts
                .filter((a) => a.profile.toLowerCase().includes(settingsFilter.toLowerCase()))
                .map((a) => a.profile)
            : null
          setAllAccounts({ enabled: true, ...(profiles && { profiles }) })
          return
        }
        if (key.name === "d") {
          const profiles = settingsFilter
            ? appState.accounts
                .filter((a) => a.profile.toLowerCase().includes(settingsFilter.toLowerCase()))
                .map((a) => a.profile)
            : null
          setAllAccounts({ enabled: false, ...(profiles && { profiles }) })
          return
        }
        if (key.name === "left" || key.name === "right") {
          const modes = ["", "on:", "off:"] as const
          const currentPrefix = settingsFilter.startsWith("on:")
            ? "on:"
            : settingsFilter.startsWith("off:")
              ? "off:"
              : ""
          const nameFilter = currentPrefix ? settingsFilter.slice(currentPrefix.length) : settingsFilter
          const idx = modes.indexOf(currentPrefix)
          const nextIdx = key.name === "right" ? (idx + 1) % modes.length : (idx - 1 + modes.length) % modes.length
          const nextMode = modes[nextIdx] ?? ""
          setSettingsFilter(nextMode + nameFilter)
          return
        }
      }

      if (key.name === "escape") {
        setView("prs")
        return
      }
    }

    // Details view
    if (view === "details") {
      if (key.name === "escape") {
        setView("prs")
      } else if (key.name === "return" && currentPR && onOpenInBrowser) {
        onOpenInBrowser(currentPR)
      } else if (key.char === "c" || key.name === "c") {
        setShowDetailsComments(!showDetailsComments)
      } else if (key.name === "1") {
        setShowDetailsComments(false)
      } else if (key.name === "2") {
        setShowDetailsComments(true)
      }
      return
    }

    // Global keybindings (prs + notifications views)
    switch (key.name) {
      case "q":
        onQuit()
        break

      case "r":
        refresh()
        break

      case "escape":
        if (filterText) {
          setFilterText("")
        } else if (view !== "prs") {
          setView("prs")
        }
        break

      case "return":
        if (view === "prs" && currentPR) {
          setView("details")
        } else if (view === "notifications") {
          const selected = notifications.items[selectedIndex]
          if (selected) {
            const profile = selected.title.replace(/\s*\(.*$/, "")
            if (/ExpiredToken|Unauthorized|AuthFailure|SSO|token|credentials/i.test(selected.message)) {
              loginToAws((profile || selected.title) as Domain.AwsProfileName)
            }
          }
        }
        break

      case "o":
        if (view === "prs" && currentPR && onOpenInBrowser) {
          onOpenInBrowser(currentPR)
        }
        break

      case "n":
        setView(view === "notifications" ? "prs" : "notifications")
        break

      case "c":
        if (view === "notifications") {
          clearNotifications()
        }
        break

      // Quick filter shortcuts (1-9) — only in prs view
      case "1":
        if (view === "prs") setQuickFilterType("all")
        break
      case "2":
        if (view === "prs") setQuickFilterType("hot")
        break
      case "3":
        if (view === "prs") {
          setQuickFilterType("mine")
          if (!quickFilterValues.mine && myScopes.length > 0) {
            setQuickFilterValues({ ...quickFilterValues, mine: myScopes[0]! })
          }
        }
        break
      case "4":
        if (view === "prs") {
          setQuickFilterType("account")
          if (!quickFilterValues.account && accounts.length > 0) {
            setQuickFilterValues({ ...quickFilterValues, account: accounts[0]! })
          }
        }
        break
      case "5":
        if (view === "prs") {
          setQuickFilterType("author")
          if (!quickFilterValues.author && authors.length > 0) {
            setQuickFilterValues({ ...quickFilterValues, author: authors[0]! })
          }
        }
        break
      case "6":
        if (view === "prs") {
          setQuickFilterType("scope")
          if (!quickFilterValues.scope && scopes.length > 0) {
            setQuickFilterValues({ ...quickFilterValues, scope: scopes[0]! })
          }
        }
        break
      case "7":
        if (view === "prs") {
          setQuickFilterType("date")
        }
        break
      case "8":
        if (view === "prs") {
          setQuickFilterType("repo")
          if (!quickFilterValues.repo && repos.length > 0) {
            setQuickFilterValues({ ...quickFilterValues, repo: repos[0]! })
          }
        }
        break
      case "9":
        if (view === "prs") {
          setQuickFilterType("status")
        }
        break

      // Cycle quick filter values with left/right
      case "left":
        if (view === "prs") {
          if (quickFilterType === "date") {
            const dateValues = ["today", "week", "month", "older"]
            const currentVal = quickFilterValues.date || "today"
            const idx = dateValues.indexOf(currentVal)
            const nextIdx = idx <= 0 ? dateValues.length - 1 : idx - 1
            setQuickFilterValues({ ...quickFilterValues, date: dateValues[nextIdx]! })
          } else if (quickFilterType === "status") {
            const statusValues = ["approved", "pending", "mergeable", "conflicts"]
            const currentVal = quickFilterValues.status || "approved"
            const idx = statusValues.indexOf(currentVal)
            const nextIdx = idx <= 0 ? statusValues.length - 1 : idx - 1
            setQuickFilterValues({ ...quickFilterValues, status: statusValues[nextIdx]! })
          } else if (
            quickFilterType === "mine" ||
            quickFilterType === "account" ||
            quickFilterType === "author" ||
            quickFilterType === "scope" ||
            quickFilterType === "repo"
          ) {
            const list =
              quickFilterType === "mine"
                ? myScopes
                : quickFilterType === "account"
                  ? accounts
                  : quickFilterType === "author"
                    ? authors
                    : quickFilterType === "repo"
                      ? repos
                      : scopes
            const currentVal = quickFilterValues[quickFilterType]
            if (list.length > 0) {
              const idx = list.indexOf(currentVal)
              const nextIdx = idx <= 0 ? list.length - 1 : idx - 1
              setQuickFilterValues({ ...quickFilterValues, [quickFilterType]: list[nextIdx]! })
            }
          }
        }
        break
      case "right":
        if (view === "prs") {
          if (quickFilterType === "date") {
            const dateValues = ["today", "week", "month", "older"]
            const currentVal = quickFilterValues.date || "today"
            const idx = dateValues.indexOf(currentVal)
            const nextIdx = idx >= dateValues.length - 1 ? 0 : idx + 1
            setQuickFilterValues({ ...quickFilterValues, date: dateValues[nextIdx]! })
          } else if (quickFilterType === "status") {
            const statusValues = ["approved", "pending", "mergeable", "conflicts"]
            const currentVal = quickFilterValues.status || "approved"
            const idx = statusValues.indexOf(currentVal)
            const nextIdx = idx >= statusValues.length - 1 ? 0 : idx + 1
            setQuickFilterValues({ ...quickFilterValues, status: statusValues[nextIdx]! })
          } else if (
            quickFilterType === "mine" ||
            quickFilterType === "account" ||
            quickFilterType === "author" ||
            quickFilterType === "scope" ||
            quickFilterType === "repo"
          ) {
            const list =
              quickFilterType === "mine"
                ? myScopes
                : quickFilterType === "account"
                  ? accounts
                  : quickFilterType === "author"
                    ? authors
                    : quickFilterType === "repo"
                      ? repos
                      : scopes
            const currentVal = quickFilterValues[quickFilterType]
            if (list.length > 0) {
              const idx = list.indexOf(currentVal)
              const nextIdx = idx >= list.length - 1 ? 0 : idx + 1
              setQuickFilterValues({ ...quickFilterValues, [quickFilterType]: list[nextIdx]! })
            }
          }
        }
        break
    }
  })

  return {
    view,
    isFiltering
  }
}
