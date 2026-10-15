/** Terminal transport decisions shared by the browser worker and its ownership-state tests. */
import { Schema } from "effect"
import { type ConnectAgent, TerminalTakenOverClose } from "../model.js"
import { clampTerminalDimensions, type TerminalDimensions } from "../terminal-dimensions.js"
import type { ConnectWorkspaceFocusFailureReason } from "../workspace-focus.js"

export type ConnectionState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "connecting"; readonly agent: ConnectAgent }
  | { readonly _tag: "connected"; readonly agent: ConnectAgent }
  | { readonly _tag: "closed"; readonly agent: ConnectAgent }
  | { readonly _tag: "controlled"; readonly agent: ConnectAgent }
  | { readonly _tag: "taken-over"; readonly agent: ConnectAgent }
  | {
    readonly _tag: "failed"
    readonly agent: ConnectAgent
    readonly detail: string
    readonly entryFocusFailure?: ConnectWorkspaceFocusFailureReason
  }

/** Classify a received close without inferring terminal ownership from arbitrary diagnostic text. */
export const terminalConnectionAfterClose = (
  agent: ConnectAgent,
  event: { readonly code: number; readonly reason: string }
): ConnectionState => {
  if (Schema.is(TerminalTakenOverClose)(event)) return { _tag: "taken-over", agent }
  if (event.code === 4_423 && event.reason === "agent already controlled") return { _tag: "controlled", agent }
  return event.code === 1_000
    ? { _tag: "closed", agent }
    : { _tag: "failed", agent, detail: event.reason || `connection closed (${String(event.code)})` }
}

/** Ordinary attachments carry dimensions and scroll opt-in, with browser location supplied at the edge. */
export const terminalAttachUrl = (
  agent: ConnectAgent,
  dimensions: TerminalDimensions,
  baseUrl: string,
  takeover = false
): string => {
  const { cols, rows } = clampTerminalDimensions(dimensions)
  const url = new URL("/v1/connect/session", baseUrl)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.searchParams.set("host", agent.host)
  url.searchParams.set("agent", agent.id)
  url.searchParams.set("cols", String(cols))
  url.searchParams.set("rows", String(rows))
  url.searchParams.set("scrollState", "1")
  if (takeover) url.searchParams.set("takeover", "1")
  return url.toString()
}
