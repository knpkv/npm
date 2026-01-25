import { Result, useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import { useKeyboard } from "@opentui/react"
import { useMemo, useRef } from "react"
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
  viewAtom
} from "../atoms/ui.js"
import { useDialog } from "../context/dialog.js"
import { DialogCommand } from "../ui/DialogCommand.js"
import { DialogCreatePR } from "../ui/DialogCreatePR.js"
import { DialogHelp } from "../ui/DialogHelp.js"
import { DialogTheme } from "../ui/DialogTheme.js"
import type { PullRequest } from "@knpkv/codecommit-core"
import type { AppState } from "@knpkv/codecommit-core"
import { extractScope } from "../ListBuilder.js"

const defaultState: AppState = {
  status: "loading",
  pullRequests: [],
  accounts: []
}

interface UseKeyboardNavOptions {
  readonly onQuit: () => void
  readonly onOpenInBrowser?: (pr: PullRequest) => void
}

/**
 * Keyboard navigation hook for the TUI
 * Handles global keybindings for view switching, filtering, help, etc.
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

  // Quick filter state
  const quickFilterType = useAtomValue(quickFilterTypeAtom)
  const setQuickFilterType = useAtomSet(quickFilterTypeAtom)
  const quickFilterValues = useAtomValue(quickFilterValuesAtom)
  const setQuickFilterValues = useAtomSet(quickFilterValuesAtom)
  const currentUser = useAtomValue(currentUserAtom)
  const setCurrentUser = useAtomSet(currentUserAtom)
  const appStateResult = useAtomValue(appStateAtom)
  const appState = Result.getOrElse(appStateResult, () => defaultState)

  // Settings filter state
  const settingsFilter = useAtomValue(settingsFilterAtom)
  const setSettingsFilter = useAtomSet(settingsFilterAtom)
  const isSettingsFiltering = useAtomValue(isSettingsFilteringAtom)
  const setIsSettingsFiltering = useAtomSet(isSettingsFilteringAtom)
  const setAllAccounts = useAtomSet(setAllAccountsAtom)

  // Extract unique authors, accounts, scopes, and repos
  const { authors, accounts, scopes, repos } = useMemo(() => {
    const authorSet = new Set<string>()
    const accountSet = new Set<string>()
    const scopeSet = new Set<string>()
    const repoSet = new Set<string>()
    for (const pr of appState.pullRequests) {
      authorSet.add(pr.author)
      accountSet.add(pr.account.id)
      repoSet.add(pr.repositoryName)
      const scope = extractScope(pr.title)
      if (scope) scopeSet.add(scope)
    }
    return {
      authors: Array.from(authorSet).sort(),
      accounts: Array.from(accountSet).sort(),
      scopes: Array.from(scopeSet).sort(),
      repos: Array.from(repoSet).sort()
    }
  }, [appState.pullRequests])

  // Sync currentUser from appState (set via STS getCallerIdentity)
  useMemo(() => {
    if (appState.currentUser && appState.currentUser !== currentUser) {
      setCurrentUser(appState.currentUser)
    }
  }, [appState.currentUser, currentUser, setCurrentUser])

  const dialog = useDialog()

  useKeyboard((key: { name: string; ctrl?: boolean; meta?: boolean; char?: string }) => {
    // If a dialog is open, don't process global keys (except command palette trigger)
    if (dialog.current) {
      return
    }

    // Handle Ctrl+P, Cmd+P, or ":" for command palette
    if ((key.name === "p" && (key.meta || key.ctrl)) || key.char === ":" || key.name === ":") {
      dialog.show(() => <DialogCommand />)
      return
    }

    // Handle Ctrl+C (Double press to exit)
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

    // Handle filter mode input (PRs)
    if (isFiltering) {
      if (key.name === "escape") {
        setIsFiltering(false)
        setFilterText("")
      } else if (key.name === "return") {
        setIsFiltering(false)
      } else if (key.name === "backspace") {
        setFilterText(filterText.slice(0, -1))
      } else {
        // Try key.char first, fallback to key.name for single printable chars
        const char = key.char || (key.name?.length === 1 ? key.name : null)
        if (char && char.length === 1) {
          setFilterText(filterText + char)
        }
      }
      return
    }

    // Handle settings filter mode input
    if (isSettingsFiltering) {
      if (key.name === "escape") {
        setIsSettingsFiltering(false)
        setSettingsFilter("")
      } else if (key.name === "return") {
        setIsSettingsFiltering(false)
      } else if (key.name === "backspace") {
        setSettingsFilter(settingsFilter.slice(0, -1))
      } else if (key.name === "left" || key.name === "right") {
        // Cycle through filter modes: "" <-> "on:" <-> "off:"
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

    // Handle "/" or "f" filter shortcut
    if (key.name === "/" || key.char === "/" || key.name === "f") {
      if (view === "settings") {
        setIsSettingsFiltering(true)
      } else {
        setIsFiltering(true)
        setView("prs")
      }
      return
    }

    // Handle settings view shortcuts
    if (view === "settings") {
      if (key.name === "a") {
        // Get filtered profiles if filter is active
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
      // Cycle filter modes with arrows (even when not in filter input mode)
      if (key.name === "left" || key.name === "right") {
        const modes = ["", "on:", "off:"] as const
        const currentPrefix = settingsFilter.startsWith("on:") ? "on:" : settingsFilter.startsWith("off:") ? "off:" : ""
        const nameFilter = currentPrefix ? settingsFilter.slice(currentPrefix.length) : settingsFilter
        const idx = modes.indexOf(currentPrefix)
        const nextIdx = key.name === "right" ? (idx + 1) % modes.length : (idx - 1 + modes.length) % modes.length
        const nextMode = modes[nextIdx] ?? ""
        setSettingsFilter(nextMode + nameFilter)
        return
      }
    }

    // Handle details view
    if (view === "details") {
      if (key.name === "escape") {
        setView("prs")
      } else if (key.name === "return" && currentPR && onOpenInBrowser) {
        onOpenInBrowser(currentPR)
      }
      return
    }

    // Global keybindings
    switch (key.name) {
      case "q":
        onQuit()
        break

      case "h":
        dialog.show(() => <DialogHelp />)
        break

      case "r":
        refresh()
        break

      case "l": {
        const authError = notifications.items.find((e) =>
          /ExpiredToken|Unauthorized|AuthFailure|SSO|token|credentials/i.test(e.message)
        )
        if (authError) {
          // Extract profile from title like "profile-name (region)"
          const profile = authError.title.split(" ")[0]
          if (profile) {
            loginToAws(profile)
          }
        }
        break
      }

      case "c":
        if (view === "notifications") {
          clearNotifications()
        } else if (view === "prs") {
          dialog.show(() => <DialogCreatePR />)
        }
        break

      case "t":
        dialog.show(() => <DialogTheme />)
        break

      case "escape":
        if (filterText) {
          setFilterText("")
        } else if (view !== "prs") {
          setView("prs")
        }
        break

      case "s":
        setView(view === "settings" ? "prs" : "settings")
        break

      case "n":
        setView(view === "notifications" ? "prs" : "notifications")
        break

      case "return":
        if (view === "prs" && currentPR) {
          setView("details")
        } else if (view === "notifications") {
          const selected = notifications.items[selectedIndex]
          if (selected) {
            // Extract profile from title like "profile-name (region)"
            const profile = selected.title.split(" ")[0]
            // Only trigger login for auth-related errors
            if (/ExpiredToken|Unauthorized|AuthFailure|SSO|token|credentials/i.test(selected.message)) {
              loginToAws(profile || selected.title)
            }
          }
        }
        break

      case "o":
        if (view === "prs" && currentPR && onOpenInBrowser) {
          onOpenInBrowser(currentPR)
        }
        break

      // Quick filter shortcuts (1-4)
      case "1":
        if (view === "prs") setQuickFilterType("all")
        break
      case "2":
        if (view === "prs") setQuickFilterType("mine")
        break
      case "3":
        if (view === "prs") {
          setQuickFilterType("account")
          // Initialize value for this type if empty
          if (!quickFilterValues.account && accounts.length > 0) {
            setQuickFilterValues({ ...quickFilterValues, account: accounts[0]! })
          }
        }
        break
      case "4":
        if (view === "prs") {
          setQuickFilterType("author")
          if (!quickFilterValues.author && authors.length > 0) {
            setQuickFilterValues({ ...quickFilterValues, author: authors[0]! })
          }
        }
        break
      case "5":
        if (view === "prs") {
          setQuickFilterType("scope")
          if (!quickFilterValues.scope && scopes.length > 0) {
            setQuickFilterValues({ ...quickFilterValues, scope: scopes[0]! })
          }
        }
        break
      case "6":
        if (view === "prs") {
          setQuickFilterType("date")
          // date already has default "today"
        }
        break
      case "7":
        if (view === "prs") {
          setQuickFilterType("repo")
          if (!quickFilterValues.repo && repos.length > 0) {
            setQuickFilterValues({ ...quickFilterValues, repo: repos[0]! })
          }
        }
        break
      case "8":
        if (view === "prs") {
          setQuickFilterType("status")
          // status already has default "approved"
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
            quickFilterType === "account" ||
            quickFilterType === "author" ||
            quickFilterType === "scope" ||
            quickFilterType === "repo"
          ) {
            const list =
              quickFilterType === "account"
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
            quickFilterType === "account" ||
            quickFilterType === "author" ||
            quickFilterType === "scope" ||
            quickFilterType === "repo"
          ) {
            const list =
              quickFilterType === "account"
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
