/**
 * The terminal selection as it travels in a WebSocket URL, both from the browser to this hub and
 * from this hub on to the host that owns the pane.
 *
 * @module
 */
import type { TerminalSelection } from "@knpkv/herdr-connect"

type TerminalSelectionFields = {
  host: string | null
  agentId: string | null
  cols: number
  rows: number
  scrollState?: true
  takeover?: true | string
}

/** The raw selection fields from a terminal URL, for `TerminalSelection` to decode. */
export const terminalSelectionInput = (url: URL) => {
  const fields: TerminalSelectionFields = {
    host: url.searchParams.get("host"),
    agentId: url.searchParams.get("agent"),
    cols: Number(url.searchParams.get("cols")),
    rows: Number(url.searchParams.get("rows"))
  }
  // Only a client that asked gets scroll states; leaving the key out keeps older clients as they were.
  if (url.searchParams.get("scrollState") === "1") fields.scrollState = true
  const takeover = url.searchParams.get("takeover")
  // Preserve malformed input so the selection Schema rejects it instead of silently attaching normally.
  if (takeover !== null) fields.takeover = takeover === "1" ? true : takeover
  return fields
}

/**
 * Forward scroll opt-in and explicit takeover intent. The caller verifies fresh takeover capability
 * before opening this URL, so an older host cannot silently treat takeover as an ordinary attach.
 */
export const remoteTerminalUrl = (terminalUrl: string, selection: TerminalSelection): URL => {
  const url = new URL(terminalUrl)
  url.searchParams.set("host", selection.host)
  url.searchParams.set("agent", selection.agentId)
  url.searchParams.set("cols", String(selection.cols))
  url.searchParams.set("rows", String(selection.rows))
  if (selection.scrollState === true) url.searchParams.set("scrollState", "1")
  if (selection.takeover === true) url.searchParams.set("takeover", "1")
  return url
}

/**
 * Relays a scroll state only to a client that asked for them: an older client closes the terminal
 * on a signal it cannot decode, whatever connector or remote host produced it.
 */
export const relayScrollState = (
  selection: TerminalSelection,
  payload: string,
  offer: (payload: string) => void
): void => {
  if (selection.scrollState === true) offer(payload)
}
