// @vitest-environment happy-dom

import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AgentContextButton } from "../../src/patterns/AgentContextButton.js"
import { render } from "../primitives/render.js"

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe("AgentContextButton", () => {
  it("shows the complete supplied agent context without optional invented work", () => {
    const button = render(<AgentContextButton agentName="Release Guardian" context="Release v2.4.0 · Copper Finch" />)
    if (button === null) throw new Error("AgentContextButton did not render")

    expect(button.tagName).toBe("BUTTON")
    expect(button.getAttribute("type")).toBe("button")
    expect(button.textContent).toContain("Ask agent")
    expect(button.textContent).toContain("Release Guardian")
    expect(button.textContent).toContain("Context")
    expect(button.textContent).toContain("Release v2.4.0 · Copper Finch")
    expect(button.querySelector("[data-rly-agent-job]")).toBeNull()
    expect(button.querySelector("svg")?.closest("span")?.className).toBeTruthy()
  })

  it("shows caller-supplied job status and zero or positive counts exactly", () => {
    const zero = render(
      <AgentContextButton
        agentName="PR reviewer"
        context="CodeCommit PR #184"
        job={{ count: 0, status: "No jobs running" }}
      />
    )
    const twenty = render(
      <AgentContextButton
        agentName="Release Guardian"
        context="Release v2.4.0"
        job={{ count: 20, status: "Checks queued" }}
      />
    )
    expect(zero?.querySelector("[data-rly-agent-job]")?.textContent).toBe("No jobs running0")
    expect(twenty?.querySelector("[data-rly-agent-job]")?.textContent).toBe("Checks queued20")
  })

  it("forwards one activation through the native controlled callback", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    const onClick = vi.fn()
    await act(async () =>
      root.render(<AgentContextButton agentName="Issue agent" context="Jira RLY-240" onClick={onClick} />)
    )
    await act(async () => host.querySelector<HTMLButtonElement>("button")?.click())
    expect(onClick).toHaveBeenCalledTimes(1)
    await act(async () => root.unmount())
  })

  it("rejects missing visible identity, context, and invalid caller counts", () => {
    expect(() => renderToStaticMarkup(<AgentContextButton agentName=" " context="Jira RLY-240" />)).toThrow(
      "AgentContextButton agentName"
    )
    expect(() => renderToStaticMarkup(<AgentContextButton agentName="Issue agent" context=" " />)).toThrow(
      "AgentContextButton context"
    )
    expect(() =>
      renderToStaticMarkup(
        <AgentContextButton agentName="Issue agent" context="Jira RLY-240" job={{ count: -1, status: "Queued" }} />
      )
    ).toThrow("AgentContextButton job count")
  })
})
