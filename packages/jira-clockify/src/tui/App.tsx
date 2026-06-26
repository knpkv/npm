/**
 * Root TUI component — keyboard routing, polling lifecycle, and view switching.
 *
 * @internal
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import { useKeyboard } from "@opentui/react"
import { useCallback, useEffect, useState } from "react"
import type { TicketState } from "../services/TicketService.js"
import type { TimerState, WorklogParams } from "../services/TimerService.js"
import { refreshAtom, ticketsAtom } from "./atoms/tickets.js"
import {
  detectRunningAtom,
  discardTimerAtom,
  retryWorklogAtom,
  startTimerAtom,
  stopTimerAtom,
  timerStateAtom
} from "./atoms/timer.js"
import { filterTextAtom, isFilteringAtom, selectedIndexAtom } from "./atoms/ui.js"
import { BigTimer } from "./components/BigTimer.js"
import { Footer, Header, TicketList } from "./components/index.js"
import { PopupInput } from "./components/PopupInput.js"
import { PopupMessage } from "./components/PopupMessage.js"
import { ThemeProvider } from "./context/theme.js"

interface AppProps {
  readonly onQuit: () => void
}

function AppContent({ onQuit }: AppProps) {
  const refresh = useAtomSet(refreshAtom)
  const detectRunning = useAtomSet(detectRunningAtom)
  const selectedIndex = useAtomValue(selectedIndexAtom)
  const setSelectedIndex = useAtomSet(selectedIndexAtom)
  const startTimer = useAtomSet(startTimerAtom)
  const stopTimer = useAtomSet(stopTimerAtom)
  const retryWorklog = useAtomSet(retryWorklogAtom)
  const discardTimer = useAtomSet(discardTimerAtom)
  const filterText = useAtomValue(filterTextAtom)
  const setFilterText = useAtomSet(filterTextAtom)
  const isFiltering = useAtomValue(isFilteringAtom)
  const setIsFiltering = useAtomSet(isFilteringAtom)
  const [showTickets, setShowTickets] = useState(false)
  const [isStopping, setIsStopping] = useState(false)
  const [isDiscarding, setIsDiscarding] = useState(false)
  // Params to retry a Jira worklog after a partial stop (Clockify saved, Jira failed)
  const [retryParams, setRetryParams] = useState<WorklogParams | null>(null)
  const [isRetrying, setIsRetrying] = useState(false)
  // Captures the view state when popup opens so it doesn't flicker on timer state change
  const [frozenOnTimer, setFrozenOnTimer] = useState(false)
  const [resultMsg, setResultMsg] = useState<{
    title: string
    lines: Array<{ text: string; color?: string }>
    type: "success" | "error"
  } | null>(null)

  const ticketsResult = useAtomValue(ticketsAtom)
  const ticketState: TicketState | null = AsyncResult.isSuccess(ticketsResult) ? ticketsResult.value : null
  const tickets = ticketState?.tickets ?? []

  const timerResult = useAtomValue(timerStateAtom)
  const timerState: TimerState | null = AsyncResult.isSuccess(timerResult) ? timerResult.value : null
  const timerActive = timerState?.active ?? false

  // Auto-switch views — frozen while popup is showing
  const hasPopup = isStopping || isDiscarding || resultMsg !== null
  useEffect(() => {
    if (hasPopup) return // don't switch while popup is open
    if (timerActive) setShowTickets(false)
  }, [timerActive, hasPopup])

  // Initial data fetch
  useEffect(() => {
    refresh()
    detectRunning()
  }, [refresh, detectRunning])

  // Clamp selectedIndex
  useEffect(() => {
    if (tickets.length > 0 && selectedIndex >= tickets.length) {
      setSelectedIndex(tickets.length - 1)
    }
  }, [tickets.length, selectedIndex, setSelectedIndex])

  // Poll Clockify every 30s — paused while popup is open
  useEffect(() => {
    if (hasPopup) return
    const interval = setInterval(() => detectRunning(), 30_000)
    return () => clearInterval(interval)
  }, [detectRunning, hasPopup])

  // Observe stop result to show accurate Jira worklog status
  const stopResult = useAtomValue(stopTimerAtom)
  useEffect(() => {
    // Guard `isWaiting`: a *second* stop re-runs the atom, which surfaces the
    // previous result with `waiting: true` (Success tag preserved) until the new
    // one settles. Without this we'd flash the prior stop's popup and could even
    // re-arm Retry with the previous ticket's worklog params.
    if (!frozenOnTimer || isStopping || AsyncResult.isWaiting(stopResult)) return
    if (AsyncResult.isSuccess(stopResult)) {
      const jiraOk = stopResult.value.jiraWorklogLogged
      // Stash params so the user can retry just the worklog if Jira failed.
      setRetryParams(jiraOk ? null : stopResult.value.worklog)
      setResultMsg({
        title: "Timer stopped",
        lines: [
          { text: "Clockify: saved ✓", color: "#00CC66" },
          jiraOk
            ? { text: "Jira worklog: saved ✓", color: "#00CC66" }
            : { text: "Jira worklog: failed ✗", color: "#FF6666" }
        ],
        type: jiraOk ? "success" : "error"
      })
    } else if (AsyncResult.isFailure(stopResult)) {
      setRetryParams(null)
      setResultMsg({
        title: "Timer stop failed",
        lines: [{ text: "Could not stop timer", color: "#FF6666" }],
        type: "error"
      })
    }
  }, [stopResult, frozenOnTimer, isStopping])

  // Observe worklog-retry result and update the popup in place
  const retryResult = useAtomValue(retryWorklogAtom)
  useEffect(() => {
    // Ignore the in-flight refresh; only act once the retry has settled.
    if (!isRetrying || AsyncResult.isWaiting(retryResult)) return
    if (AsyncResult.isSuccess(retryResult)) {
      setIsRetrying(false)
      if (retryResult.value) {
        setRetryParams(null)
        setResultMsg({
          title: "Timer stopped",
          lines: [
            { text: "Clockify: saved ✓", color: "#00CC66" },
            { text: "Jira worklog: saved ✓", color: "#00CC66" }
          ],
          type: "success"
        })
      } else {
        // Still failing — keep retryParams so the user can try again.
        setResultMsg({
          title: "Timer stopped",
          lines: [
            { text: "Clockify: saved ✓", color: "#00CC66" },
            { text: "Jira worklog: still failing ✗", color: "#FF6666" }
          ],
          type: "error"
        })
      }
    } else if (AsyncResult.isFailure(retryResult)) {
      setIsRetrying(false)
      setResultMsg({
        title: "Timer stopped",
        lines: [
          { text: "Clockify: saved ✓", color: "#00CC66" },
          { text: "Jira worklog: retry failed ✗", color: "#FF6666" }
        ],
        type: "error"
      })
    }
  }, [retryResult, isRetrying])

  const handleRetryWorklog = useCallback(() => {
    if (!retryParams) return
    setIsRetrying(true)
    retryWorklog(retryParams)
  }, [retryParams, retryWorklog])

  // Stop handler with comment — freeze view so popup stays visible
  const handleStop = useCallback(
    (comment: string) => {
      setFrozenOnTimer(true) // keep big timer visible while popup shows
      setIsStopping(false)
      stopTimer({ comment: comment.trim() || undefined })
    },
    [stopTimer]
  )

  useKeyboard((key: { name: string; ctrl?: boolean; meta?: boolean; char?: string }) => {
    if (key.name === "c" && key.ctrl) {
      onQuit()
      return
    }

    // Popup open — block all keys (input handles its own)
    if (isStopping || resultMsg) return

    // Filter mode
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
        if (char && char.length === 1) setFilterText(filterText + char)
      }
      return
    }

    // Toggle timer ↔ tickets
    if (key.name === "l" || key.name === "tab") {
      if (timerActive) setShowTickets(!showTickets)
      return
    }

    // Navigation (ticket list only)
    if (showTickets || !timerActive) {
      if (key.name === "up" || key.name === "k") {
        setSelectedIndex(Math.max(0, selectedIndex - 1))
        return
      }
      if (key.name === "down" || key.name === "j") {
        setSelectedIndex(Math.min(tickets.length - 1, selectedIndex + 1))
        return
      }
    }

    switch (key.name) {
      case "q":
        onQuit()
        break
      case "r":
        refresh()
        break
      case "/":
      case "f":
        if (showTickets || !timerActive) setIsFiltering(true)
        break
      case "s":
      case "return": {
        if (showTickets || !timerActive) {
          const ticket = tickets[selectedIndex]
          if (ticket) startTimer(ticket)
        }
        break
      }
      case "x":
        if (timerActive) setIsStopping(true)
        break
      case "d":
        if (timerActive) setIsDiscarding(true)
        break
      case "escape":
        if (filterText) setFilterText("")
        else if (showTickets && timerActive) setShowTickets(false)
        break
    }
  })

  // Single return — popups overlay on top of any view
  // frozenOnTimer keeps big timer visible while result popup is showing
  const showBigTimer = (timerActive || frozenOnTimer) && !showTickets

  return (
    <box style={{ flexDirection: "column", height: "100%", width: "100%" }}>
      <Header />
      {showBigTimer ? (
        <BigTimer />
      ) : (
        <>
          <TicketList />
          <Footer />
        </>
      )}

      {/* Popup overlays */}
      {isDiscarding ? (
        <PopupMessage
          title="Discard timer?"
          lines={[
            { text: "This will delete the Clockify entry.", color: "#FFCC00" },
            { text: "No Jira worklog will be created.", color: "#FFCC00" }
          ]}
          type="error"
          onDismiss={() => {
            discardTimer()
            setIsDiscarding(false)
            setFrozenOnTimer(true)
            setResultMsg({
              title: "Timer discarded",
              lines: [{ text: "Clockify entry deleted.", color: "#888888" }],
              type: "info" as "success"
            })
          }}
        />
      ) : null}
      {isStopping ? (
        <PopupInput
          title="Stop timer — add a comment"
          placeholder="What did you work on? (empty to skip)"
          onSubmit={handleStop}
          onCancel={() => setIsStopping(false)}
        />
      ) : null}
      {resultMsg ? (
        <PopupMessage
          title={resultMsg.title}
          lines={resultMsg.lines}
          type={resultMsg.type}
          onRetry={retryParams ? handleRetryWorklog : undefined}
          retrying={isRetrying}
          onDismiss={() => {
            if (isRetrying) return // don't dismiss mid-retry
            setResultMsg(null)
            setFrozenOnTimer(false)
            setRetryParams(null)
          }}
        />
      ) : null}
    </box>
  )
}

export function App({ onQuit }: AppProps) {
  return (
    <ThemeProvider>
      <AppContent onQuit={onQuit} />
    </ThemeProvider>
  )
}
