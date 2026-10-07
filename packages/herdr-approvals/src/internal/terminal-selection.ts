/**
 * The terminal selection as it travels in a WebSocket URL, both from the browser to this hub and
 * from this hub on to the host that owns the pane.
 *
 * @module
 */
import type { TerminalSelection } from "@knpkv/herdr-connect"

/** The raw selection fields from a terminal URL, for `TerminalSelection` to decode. */
export const terminalSelectionInput = (url: URL) => {
  const fields = {
    host: url.searchParams.get("host"),
    agentId: url.searchParams.get("agent"),
    cols: Number(url.searchParams.get("cols")),
    rows: Number(url.searchParams.get("rows"))
  }
  // Only a client that asked gets scroll states; leaving the key out keeps older clients as they were.
  if (url.searchParams.get("scrollState") !== "1") return fields
  return { ...fields, scrollState: true }
}

/**
 * The remote host's terminal URL for a selection. The client's scroll-state opt-in goes along, so a
 * remote host never sends a signal this client cannot read.
 */
export const remoteTerminalUrl = (terminalUrl: string, selection: TerminalSelection): URL => {
  const url = new URL(terminalUrl)
  url.searchParams.set("host", selection.host)
  url.searchParams.set("agent", selection.agentId)
  url.searchParams.set("cols", String(selection.cols))
  url.searchParams.set("rows", String(selection.rows))
  if (selection.scrollState === true) url.searchParams.set("scrollState", "1")
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
