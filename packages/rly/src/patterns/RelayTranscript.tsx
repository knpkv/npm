import type { ReactElement, ReactNode } from "react"
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Icon } from "../foundations/Icon.js"
import { RlyLink } from "../foundations/LinkProvider.js"
import { cssClass, requireText } from "../internal/component.js"
import styles from "./RelayTranscript.module.css"

const style = (name: string): string => cssClass(styles, name)

/** A cited object: the link text is the location itself ("src/patch-reader.ts:14"). */
export interface RlyRelayCite {
  readonly href: string
  readonly label: string
}

/** One tool call in an activity burst, from ToolStarted and ToolFinished (server-built summaries). */
export interface RlyRelayTool {
  readonly call: string
  readonly cites?: ReadonlyArray<RlyRelayCite>
  readonly status: "running" | "ok" | "failed"
  readonly summary: string
}

/** One entry in a Relay conversation, in the order it happened. */
export type RlyRelayTranscriptItem =
  | { readonly _tag: "You"; readonly id: string; readonly text: string }
  | { readonly _tag: "Relay"; readonly id: string; readonly text: string }
  /** A system note (why a send was refused, a changed registration): neither turn, not announced. */
  | { readonly _tag: "Note"; readonly id: string; readonly text: string }
  /** A contiguous burst of tool work between prose, with its summary ("Read 4 files and ran 1 check"). */
  | {
      readonly _tag: "Activity"
      readonly id: string
      readonly summary: string
      readonly tools: ReadonlyArray<RlyRelayTool>
    }
  /** How a run ended; Finished may carry its duration, Failed its cause and the next action. */
  | { readonly _tag: "RunFinished"; readonly id: string; readonly seconds?: number }
  | { readonly _tag: "RunCancelled"; readonly id: string }
  | { readonly _tag: "RunFailed"; readonly cause: string; readonly fix: string; readonly id: string }

/** Inputs for the transcript. */
export interface RelayTranscriptProps {
  readonly items: ReadonlyArray<RlyRelayTranscriptItem>
  /** A run is in flight; shows "Relay is writing…" (not announced; the announcer covers start and end). */
  readonly streaming: boolean
}

const statusWord = {
  failed: "Failed",
  ok: "Done",
  running: "Running"
} satisfies Readonly<Record<RlyRelayTool["status"], string>>

/** Prose with fenced code blocks; a block scrolls inside itself rather than breaking its lines. */
const Prose = ({ text }: { readonly text: string }): ReactElement => (
  <div className={style("prose")}>
    {text.split(/^```[^\n]*\n?/m).map((part, index) =>
      index % 2 === 1 ? (
        <pre className={style("code")} key={index} tabIndex={0}>
          <code>{part.replace(/\n$/, "")}</code>
        </pre>
      ) : part.trim() === "" ? null : (
        <p className={style("paragraph")} key={index}>
          {part.trim()}
        </p>
      )
    )}
  </div>
)

const Activity = ({ item }: { readonly item: Extract<RlyRelayTranscriptItem, { _tag: "Activity" }> }): ReactElement => {
  const running = item.tools.some((tool) => tool.status === "running")
  const failed = item.tools.some((tool) => tool.status === "failed")
  return (
    <details className={style("activity")} data-state={running ? "running" : failed ? "failed" : "done"}>
      <summary className={style("activitySummary")}>
        <Icon decorative name={running ? "loader" : failed ? "alert" : "check"} size="small" />
        <span>{requireText(item.summary, "RelayTranscript activity summary")}</span>
      </summary>
      <ul className={style("tools")}>
        {item.tools.map((tool) => (
          <li className={style("tool")} data-status={tool.status} key={tool.call}>
            <span className={style("toolSummary")}>{requireText(tool.summary, "RelayTranscript tool summary")}</span>
            <span className={style("toolStatus")}>{statusWord[tool.status]}</span>
            {tool.cites === undefined || tool.cites.length === 0 ? null : (
              <span className={style("cites")}>
                {tool.cites.map((cite) => (
                  <RlyLink className={style("cite")} href={cite.href} key={cite.href}>
                    {requireText(cite.label, "RelayTranscript cite label")}
                  </RlyLink>
                ))}
              </span>
            )}
          </li>
        ))}
      </ul>
    </details>
  )
}

const RunOutcome = ({ item }: { readonly item: RlyRelayTranscriptItem }): ReactNode => {
  switch (item._tag) {
    case "RunFinished":
      return <p className={style("outcome")}>{item.seconds === undefined ? "Done." : `Done in ${item.seconds}s.`}</p>
    case "RunCancelled":
      return <p className={style("outcome")}>Stopped. What Relay wrote and did before stays here.</p>
    case "RunFailed":
      return (
        <p className={style("outcome")} data-outcome="failed">
          <strong>{requireText(item.cause, "RelayTranscript failure cause")}</strong>{" "}
          {requireText(item.fix, "RelayTranscript failure fix")}
        </p>
      )
    default:
      return null
  }
}

/** What the announcer says when an item ends a run; undefined for every other item. */
const announcementFor = (item: RlyRelayTranscriptItem): string | undefined => {
  switch (item._tag) {
    case "RunFinished":
      return "Relay finished."
    case "RunCancelled":
      return "Relay stopped."
    case "RunFailed":
      return `Relay failed: ${item.cause}`
    default:
      return undefined
  }
}

/** Within this distance of the end counts as reading the latest. */
const AT_END_SLACK = 24

/**
 * A Relay conversation (Relay UX decision). Your turns sit at the inline end as bubbles; Relay's turns
 * are plain prose, its code blocks scrolling in place. Each burst of tool work is one collapsed row in
 * reading order, expanding to each call's summary, status and citations (link text is the location).
 * One polite announcer, outside the scrolling content, says when a run starts, finishes, stops or
 * fails, never per token. Each turn names its speaker for assistive technology ("You", "Relay").
 * Inside RelayPanel the transcript follows new content only while you are at the end, or when the new
 * turn is yours; reading earlier turns, a "New messages" button appears instead, so scroll is never
 * taken. Citations route through LinkProvider, so a host keeps its own navigation.
 */
export const RelayTranscript = ({ items, streaming }: RelayTranscriptProps): ReactElement => {
  const root = useRef<HTMLDivElement | null>(null)
  const atEnd = useRef(true)
  const [behind, setBehind] = useState(false)
  const [announcement, setAnnouncement] = useState("")
  // Words waiting to be announced, numbered so a repeat of the same words is still a change. Kept
  // apart from the items, so a token arriving before the next frame cannot cancel the delivery.
  const [pending, setPending] = useState<{ readonly count: number; readonly words: string } | null>(null)
  // Runs already over when the transcript mounts (history, a reopen, a presentation change) are not news.
  const announced = useRef<ReadonlySet<string> | null>(null)
  if (announced.current === null) {
    announced.current = new Set(items.filter((item) => announcementFor(item) !== undefined).map((item) => item.id))
  }
  const seen = useRef(new Set(items.map((item) => item.id)))
  const wasStreaming = useRef(streaming)

  const scroller = useCallback((): HTMLElement | null => root.current?.closest("[data-rly-relay-scroll]") ?? null, [])
  // Always instant: a smooth jump's intermediate scroll events would read as the reader scrolling away
  // while content keeps arriving.
  const toEnd = useCallback(() => {
    const element = scroller()
    if (element === null) return
    element.scrollTo({ behavior: "auto", top: element.scrollHeight })
    atEnd.current = true
    setBehind(false)
  }, [scroller])

  useEffect(() => {
    const element = scroller()
    if (element === null) return
    const measure = (): void => {
      atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight <= AT_END_SLACK
      if (atEnd.current) setBehind(false)
    }
    element.addEventListener("scroll", measure, { passive: true })
    // Content can grow without a scroll event (the reader opening an activity row), which moves the end
    // away from the reader; re-measure so the next update does not pull them back down.
    const view = element.ownerDocument.defaultView
    const content = root.current
    const observer =
      view !== null && "ResizeObserver" in view && content !== null ? new view.ResizeObserver(measure) : null
    if (content !== null) observer?.observe(content)
    return () => {
      element.removeEventListener("scroll", measure)
      observer?.disconnect()
    }
  }, [scroller])

  // New content: follow it if the reader was at the end, or if it is the reader's own new turn;
  // otherwise offer the jump.
  useLayoutEffect(() => {
    const fresh = items.filter((item) => !seen.current.has(item.id))
    for (const item of fresh) seen.current.add(item.id)
    if (atEnd.current || fresh.some((item) => item._tag === "You")) toEnd()
    else setBehind(true)
  }, [items, streaming, toEnd])

  // Announce run state changes once each; tokens never reach the live region.
  useEffect(() => {
    let words: string | undefined
    if (streaming && !wasStreaming.current) words = "Relay is answering."
    wasStreaming.current = streaming
    const known = new Set(announced.current)
    for (const item of items) {
      const said = announcementFor(item)
      if (said === undefined || known.has(item.id)) continue
      known.add(item.id)
      words = said
    }
    announced.current = known
    if (words !== undefined) {
      const said = words
      setPending((previous) => ({ count: (previous?.count ?? 0) + 1, words: said }))
    }
  }, [items, streaming])

  // Clear, then refill on the next frame, so a repeat of the same words is heard.
  useEffect(() => {
    if (pending === null) return
    const view = root.current?.ownerDocument.defaultView
    setAnnouncement("")
    if (view === null || view === undefined) return setAnnouncement(pending.words)
    const frame = view.requestAnimationFrame(() => setAnnouncement(pending.words))
    return () => view.cancelAnimationFrame(frame)
  }, [pending])

  return (
    <div className={style("root")} ref={root}>
      <ol className={style("items")}>
        {items.map((item) => (
          <Fragment key={item.id}>
            {item._tag === "You" ? (
              <li className={style("you")}>
                <span className={style("speaker")}>You: </span>
                <p className={style("bubble")}>{requireText(item.text, "RelayTranscript turn")}</p>
              </li>
            ) : item._tag === "Relay" ? (
              <li className={style("relay")}>
                <span className={style("speaker")}>Relay: </span>
                <Prose text={item.text} />
              </li>
            ) : item._tag === "Note" ? (
              <li className={style("note")}>
                <span className={style("speaker")}>Note: </span>
                {requireText(item.text, "RelayTranscript note")}
              </li>
            ) : item._tag === "Activity" ? (
              <li className={style("relay")}>
                <Activity item={item} />
              </li>
            ) : (
              <li className={style("relay")}>
                <RunOutcome item={item} />
              </li>
            )}
          </Fragment>
        ))}
      </ol>
      {streaming ? <p className={style("streaming")}>Relay is writing…</p> : null}
      {behind ? (
        <button
          className={style("jump")}
          onClick={() => {
            toEnd()
            // The button goes away; focus moves to the scrolling body rather than dropping to the page.
            scroller()?.focus({ preventScroll: true })
          }}
          type="button"
        >
          New messages
        </button>
      ) : null}
      <p aria-live="polite" className={style("announcer")}>
        {announcement}
      </p>
    </div>
  )
}
