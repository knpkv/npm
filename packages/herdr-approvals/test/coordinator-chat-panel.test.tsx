import { describe, expect, it } from "@effect/vitest"
import type { ChatHistory } from "@knpkv/herdr-coordinator/model"
import { renderToStaticMarkup } from "react-dom/server"
import { CoordinatorChatPanel } from "../src/approval-app-view.js"

const history: ChatHistory = {
  entries: [
    {
      createdAt: 1_000,
      id: "turn-1",
      message: "Summarise the fleet",
      mode: "ask",
      reply: null,
      state: "failed",
      updatedAt: 2_000
    },
    {
      createdAt: 3_000,
      id: "turn-2",
      message: "Ship the release",
      mode: "work",
      reply: "Started",
      state: "running",
      updatedAt: 4_000
    }
  ]
}

const render = (): string =>
  renderToStaticMarkup(<CoordinatorChatPanel busy={false} history={history} onSubmit={undefined} />)

describe("coordinator chat panel", () => {
  it("names no host of its own and says persistence in words, not a chip", () => {
    const markup = render()
    expect(markup).not.toContain("KNPKV-SER8")
    expect(markup).not.toContain(">Persistent<")
    expect(markup).toContain("Conversations are kept across restarts.")
  })

  it("reads each turn as who asked and its state as a word", () => {
    const markup = render()
    expect(markup).toContain("You asked<")
    expect(markup).toContain("You asked for work<")
    expect(markup).not.toContain("You · ")
    expect(markup).toContain('data-state="failed"')
    expect(markup).toContain(">Failed<")
  })

  it("makes the scrolling history a named log a keyboard can reach", () => {
    const markup = render()
    expect(markup).toContain('role="log"')
    expect(markup).toContain('aria-label="Coordinator conversation"')
    expect(markup).toContain('tabindex="0"')
  })
})
