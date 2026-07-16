// @vitest-environment happy-dom

import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { RlyAgentProposal } from "../../src/patterns/AgentProposal.js"
import { GovernedActionReview, type RlyGovernedActionState } from "../../src/patterns/GovernedActionReview.js"
import { render } from "../primitives/render.js"

const proposal = {
  id: "proposal-release-240",
  agent: {
    id: "release-agent",
    name: "Relay agent",
    role: "Release context assistant",
    avatarFallback: "RA"
  },
  capability: "Start a production CodePipeline execution",
  context: "Release v2.4.0 · Copper Finch",
  evidence: [
    { id: "commit", label: "CodeCommit revision", reference: "8fa21c7" },
    { id: "approval", label: "Jira approval", reference: "RPS-6307 / approval-119" }
  ],
  expectedRevision: "8fa21c7",
  impact: "Deploy one immutable artifact to production-eu-west-1.",
  target: "payments-production / pipeline execution"
} satisfies RlyAgentProposal

const reviewer = { id: "dev-shah", name: "Dev Shah", role: "Production authorizer" }
const commonProps = {
  confirmationLabel: "I confirm the exact revision, target, impact, and evidence above.",
  onAuthorize: () => undefined,
  onConfirmationChange: () => undefined,
  onReject: () => undefined,
  outcome: <p>No decision recorded.</p>,
  proposal,
  reviewer
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe("GovernedActionReview", () => {
  it("presents the exact governed action and separates the agent proposal from human authorization", () => {
    const review = render(<GovernedActionReview {...commonProps} isConfirmed={false} state="pending" />)
    expect(review?.textContent).toContain("Human authorization")
    expect(review?.textContent).toContain(
      "The agent proposed this action. Only the named human reviewer can authorize it."
    )
    expect(review?.textContent).toContain(proposal.capability)
    expect(review?.textContent).toContain(proposal.target)
    expect(review?.textContent).toContain(proposal.expectedRevision)
    expect(review?.textContent).toContain(proposal.impact)
    expect(review?.textContent).toContain("Dev Shah")
    expect(review?.querySelectorAll("[data-rly-governed-action-evidence] li")).toHaveLength(2)
  })

  it("keeps authorization disabled and callback-guarded until caller confirmation is true", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    const onAuthorize = vi.fn()
    const onConfirmationChange = vi.fn()

    await act(async () =>
      root.render(
        <GovernedActionReview
          {...commonProps}
          isConfirmed={false}
          onAuthorize={onAuthorize}
          onConfirmationChange={onConfirmationChange}
          state="pending"
        />
      )
    )
    const authorize = host.querySelector<HTMLButtonElement>("button:last-of-type")
    const confirmation = host.querySelector<HTMLInputElement>("input[type='checkbox']")
    if (authorize === null || confirmation === null) throw new Error("Governed decision controls did not render")
    expect(authorize.disabled).toBe(true)
    authorize.click()
    expect(onAuthorize).not.toHaveBeenCalled()
    confirmation.click()
    expect(onConfirmationChange).toHaveBeenCalledWith(true)

    await act(async () =>
      root.render(
        <GovernedActionReview
          {...commonProps}
          isConfirmed
          onAuthorize={onAuthorize}
          onConfirmationChange={onConfirmationChange}
          state="pending"
        />
      )
    )
    const enabledAuthorize = host.querySelector<HTMLButtonElement>("button:last-of-type")
    if (enabledAuthorize === null) throw new Error("Governed authorization control did not render")
    expect(enabledAuthorize.disabled).toBe(false)
    enabledAuthorize.click()
    expect(onAuthorize).toHaveBeenCalledTimes(1)
    await act(async () => root.unmount())
  })

  it("renders truthful non-pending outcomes without decision controls", () => {
    const states = [
      "rejected",
      "authorized",
      "executing",
      "succeeded",
      "failed",
      "cancelled"
    ] satisfies ReadonlyArray<RlyGovernedActionState>
    for (const state of states) {
      const review = render(
        <GovernedActionReview
          {...commonProps}
          isConfirmed={false}
          outcome={<p>Caller supplied {state} detail.</p>}
          state={state}
        />
      )
      expect(review?.getAttribute("data-rly-governed-action-state")).toBe(state)
      expect(review?.textContent).toContain(`Caller supplied ${state} detail.`)
      expect(review?.querySelector("form")).toBeNull()
      expect(review?.querySelector("button")).toBeNull()
    }
  })

  it("calls rejection directly while leaving provider execution outside the component", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    const onReject = vi.fn()
    await act(async () =>
      root.render(<GovernedActionReview {...commonProps} isConfirmed={false} onReject={onReject} state="pending" />)
    )
    const reject = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Reject proposal")
    )
    if (reject === undefined) throw new Error("Governed rejection control did not render")
    reject.click()
    expect(onReject).toHaveBeenCalledTimes(1)
    await act(async () => root.unmount())
  })

  it("rejects blank confirmation and exact proposal fields", () => {
    expect(() =>
      renderToStaticMarkup(
        <GovernedActionReview {...commonProps} confirmationLabel=" " isConfirmed={false} state="pending" />
      )
    ).toThrow("confirmationLabel")
    expect(() =>
      renderToStaticMarkup(
        <GovernedActionReview
          {...commonProps}
          isConfirmed={false}
          proposal={{ ...proposal, target: " " }}
          state="pending"
        />
      )
    ).toThrow("AgentProposal target")
  })
})
