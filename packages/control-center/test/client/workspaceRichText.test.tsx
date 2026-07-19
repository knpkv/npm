// @vitest-environment happy-dom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"

import { WorkspaceRichText } from "../../src/client/entities/WorkspaceRichText.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

let mountedRoot: Root | undefined

afterEach(async () => {
  if (mountedRoot !== undefined) await act(async () => mountedRoot?.unmount())
  mountedRoot = undefined
  document.body.replaceChildren()
})

const renderRichText = async (value: string): Promise<HTMLElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  mountedRoot = createRoot(host)
  await act(async () => mountedRoot?.render(<WorkspaceRichText value={value} />))
  return host
}

describe("WorkspaceRichText", () => {
  it("renders normalized Jira structure as semantic document content", async () => {
    const host = await renderRichText(
      [
        "## Guarded rollout",
        "",
        "- Verify the canary",
        "- Watch duplicate captures",
        "",
        "```ts",
        "const guarded = true",
        "```",
        "",
        "> Stop if the ledger diverges."
      ].join("\n")
    )

    expect(host.querySelector("h3")?.textContent).toBe("Guarded rollout")
    expect([...host.querySelectorAll("li")].map(({ textContent }) => textContent)).toEqual([
      "Verify the canary",
      "Watch duplicate captures"
    ])
    expect(host.querySelector("pre code")?.textContent).toContain("const guarded = true")
    expect(host.querySelector("blockquote")?.textContent).toContain("Stop if the ledger diverges.")
    expect(host.textContent).not.toContain("##")
  })

  it("keeps safe source links external without activating unsafe targets or raw HTML", async () => {
    const host = await renderRichText(
      "[Runbook](https://wiki.example.test/runbook) [Unsafe](javascript:alert(1)) <script>bad()</script>"
    )

    const links = [...host.querySelectorAll("a")]
    expect(links).toHaveLength(1)
    expect(links[0]?.getAttribute("href")).toBe("https://wiki.example.test/runbook")
    expect(links[0]?.getAttribute("target")).toBe("_blank")
    expect(links[0]?.getAttribute("rel")).toBe("noreferrer")
    expect(host.textContent).toContain("Unsafe")
    expect(host.querySelector("script")).toBeNull()
  })
})
