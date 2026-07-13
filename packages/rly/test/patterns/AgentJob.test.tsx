// @vitest-environment happy-dom

import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AgentJob } from "../../src/patterns/AgentJob.js"
import { render } from "../primitives/render.js"

const commonProps = {
  capability: "Review pull request",
  context: <p>Release 2.8.0 · production · PR-191</p>,
  evidence: <code>PR-191@8f6d21a</code>,
  heading: "Review PR-191",
  provider: "Local Codex",
  revision: "8f6d21a"
}

// @ts-expect-error terminal jobs require a truthful outcome
const terminalWithoutOutcome = <AgentJob {...commonProps} state="failed" />
const terminalWithCancellation = (
  // @ts-expect-error terminal jobs cannot expose a cancellation callback
  <AgentJob {...commonProps} onCancel={() => undefined} outcome={<p>Failed.</p>} state="failed" />
)
const cancelRequestedWithCancellation = (
  // @ts-expect-error a requested cancellation cannot be requested twice
  <AgentJob {...commonProps} onCancel={() => undefined} state="cancel-requested" />
)
void [terminalWithoutOutcome, terminalWithCancellation, cancelRequestedWithCancellation]

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe("AgentJob", () => {
  it("renders all six explicit job states without implying execution", () => {
    const activeStates = [
      <AgentJob {...commonProps} key="queued" state="queued" />,
      <AgentJob {...commonProps} key="running" progress={64} state="running" />,
      <AgentJob {...commonProps} key="cancel-requested" progress={67} state="cancel-requested" />
    ]
    const terminalStates = [
      <AgentJob {...commonProps} key="succeeded" outcome={<p>Two findings.</p>} state="succeeded" />,
      <AgentJob {...commonProps} key="failed" outcome={<p>Checkout failed.</p>} state="failed" />,
      <AgentJob {...commonProps} key="cancelled" outcome={<p>No result produced.</p>} state="cancelled" />
    ]
    const gallery = render(
      <main>
        {activeStates}
        {terminalStates}
      </main>
    )
    for (const state of ["queued", "running", "cancel-requested", "succeeded", "failed", "cancelled"]) {
      expect(gallery?.querySelector(`[data-rly-agent-job-state='${state}']`)).not.toBeNull()
    }
    expect(gallery?.querySelectorAll("[data-rly-agent-job-outcome]")).toHaveLength(3)
  })

  it("keeps provider, capability, context, evidence, sandbox, revision, and progress explicit", () => {
    const job = render(
      <AgentJob {...commonProps} onCancel={() => undefined} progress={64.4} sandbox="rly/review-191" state="running" />
    )
    expect(job?.textContent).toContain("Local Codex")
    expect(job?.textContent).toContain("Review pull request")
    expect(job?.querySelector("[data-rly-agent-job-context]")?.textContent).toContain("Release 2.8.0")
    expect(job?.querySelector("[data-rly-agent-job-evidence]")?.textContent).toContain("PR-191@8f6d21a")
    expect(job?.textContent).toContain("rly/review-191")
    expect(job?.textContent).toContain("8f6d21a")
    expect(job?.querySelector("progress")?.getAttribute("value")).toBe("64.4")
    expect(job?.textContent).toContain("64%")
  })

  it("reports cancellation without changing controlled running state or stealing focus", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    const onCancel = vi.fn()
    await act(async () => root.render(<AgentJob {...commonProps} onCancel={onCancel} progress={64} state="running" />))
    const button = host.querySelector<HTMLButtonElement>("button")
    button?.focus()
    await act(async () => button?.click())
    expect(onCancel).toHaveBeenCalledOnce()
    expect(host.querySelector("[data-rly-agent-job-state='running']")).not.toBeNull()
    expect(document.activeElement).toBe(button)
    await act(async () => root.unmount())
  })

  it("shows cancellation only while queued or running and requires truthful terminal content", () => {
    const onCancel = vi.fn()
    const gallery = render(
      <main>
        <AgentJob {...commonProps} onCancel={onCancel} state="queued" />
        <AgentJob {...commonProps} onCancel={onCancel} progress={20} state="running" />
        <AgentJob {...commonProps} state="cancel-requested" />
        <AgentJob {...commonProps} outcome={<p>Review succeeded with no findings.</p>} state="succeeded" />
        <AgentJob {...commonProps} outcome={<p>Provider exited before producing a review.</p>} state="failed" />
        <AgentJob {...commonProps} outcome={<p>Cancelled; no review was produced.</p>} state="cancelled" />
      </main>
    )
    expect(gallery?.querySelectorAll("button")).toHaveLength(2)
    expect(gallery?.querySelector("[data-rly-agent-job-state='cancel-requested'] button")).toBeNull()
    expect(gallery?.querySelector("[data-rly-agent-job-state='failed']")?.textContent).toContain(
      "Provider exited before producing a review."
    )
  })

  it("rejects blank metadata and invalid progress", () => {
    expect(() => renderToStaticMarkup(<AgentJob {...commonProps} provider=" " state="queued" />)).toThrow(
      "AgentJob provider"
    )
    expect(() => renderToStaticMarkup(<AgentJob {...commonProps} progress={101} state="running" />)).toThrow(
      "between 0 and 100"
    )
    expect(() => renderToStaticMarkup(<AgentJob {...commonProps} revision=" " state="queued" />)).toThrow(
      "AgentJob revision"
    )
    expect(() => renderToStaticMarkup(<AgentJob {...commonProps} outcome={null} state="failed" />)).toThrow(
      "AgentJob terminal outcome"
    )
  })
})
