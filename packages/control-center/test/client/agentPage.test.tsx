import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router"
import { describe, expect, it } from "vitest"

import { AgentPage } from "../../src/client/AgentPage.js"

const renderAgentPage = (from: string): string =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/agent?from=${encodeURIComponent(from)}`]}>
      <AgentPage />
    </MemoryRouter>
  )

describe("AgentPage context", () => {
  it("names an exact canonical release context without substituting another entity", () => {
    const path = "/w/01890f6f-6d6a-7cc0-98d2-000000000001/releases/01890f6f-6d6a-7cc0-98d2-000000000011/preview"
    const markup = renderAgentPage(path)
    expect(markup).toContain("Release 000011")
    expect(markup).toContain("01890f6f-6d6a-7cc0-98d2-000000000001")
    expect(markup).toContain(`href="${path}"`)
    expect(markup).not.toContain("The workspace-wide view")
  })

  it("rejects external and unknown contexts instead of falling back to Overview", () => {
    for (const path of ["https://example.com/release", "/api/v1/portfolio/snapshot", "/w/not-an-id/overview"]) {
      const markup = renderAgentPage(path)
      expect(markup).toContain("Context unavailable")
      expect(markup).toContain("No fallback workspace or entity is substituted.")
      expect(markup).not.toContain("Return to Overview")
    }
  })
})
