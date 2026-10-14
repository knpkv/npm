import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { terminalAttachUrl, terminalConnectionAfterClose } from "../src/internal/terminal-connection.js"
import { ConnectAgent } from "../src/model.js"

const agent = Schema.decodeUnknownSync(ConnectAgent)({
  host: "hub",
  id: "agent-control",
  kind: "codex",
  name: "Agent",
  state: "working",
  work: "Checking changes",
  lastActivityAt: 0
})

describe("terminal ownership close mapping", () => {
  it("puts takeover intent only on the explicit request, never on subsequent ordinary requests", () => {
    const url = new URL(terminalAttachUrl(agent, { cols: 1, rows: 1 }, "https://hub.example.test/connect/", true))
    expect(url.protocol).toBe("wss:")
    expect(url.searchParams.get("takeover")).toBe("1")
    expect(url.searchParams.get("scrollState")).toBe("1")
    expect(url.searchParams.get("cols")).toBe("20")
    expect(url.searchParams.get("rows")).toBe("5")
    const reconnect = new URL(terminalAttachUrl(agent, { cols: 100, rows: 30 }, "https://hub.example.test/connect/"))
    expect(reconnect.searchParams.has("takeover")).toBe(false)
    const ordinary = new URL(
      terminalAttachUrl(agent, { cols: 100, rows: 30 }, "https://hub.example.test/connect/", false)
    )
    expect(ordinary.searchParams.has("takeover")).toBe(false)
  })
  it("maps only the exact controller refusal to the controlled state", () => {
    expect(terminalConnectionAfterClose(agent, { code: 4_423, reason: "agent already controlled" }))
      .toEqual({ _tag: "controlled", agent })
    expect(terminalConnectionAfterClose(agent, { code: 4_423, reason: "TerminalBusyError" }))
      .toEqual({ _tag: "failed", agent, detail: "TerminalBusyError" })
    expect(terminalConnectionAfterClose(agent, { code: 4_503, reason: "agent already controlled" }))
      .toEqual({ _tag: "failed", agent, detail: "agent already controlled" })
  })

  it("maps the typed takeover pair without treating unrelated close text as takeover", () => {
    expect(terminalConnectionAfterClose(agent, { code: 4_424, reason: "taken_over" }))
      .toEqual({ _tag: "taken-over", agent })
    expect(terminalConnectionAfterClose(agent, { code: 4_424, reason: "other" }))
      .toEqual({ _tag: "failed", agent, detail: "other" })
    expect(terminalConnectionAfterClose(agent, { code: 1_000, reason: "taken_over" }))
      .toEqual({ _tag: "closed", agent })
    expect(terminalConnectionAfterClose(agent, { code: 1_006, reason: "" }))
      .toEqual({ _tag: "failed", agent, detail: "connection closed (1006)" })
  })
})
