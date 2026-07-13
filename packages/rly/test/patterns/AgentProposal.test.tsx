// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { AgentProposal, type RlyAgentProposal } from "../../src/patterns/AgentProposal.js"
import { StateLabel } from "../../src/primitives/StateLabel.js"
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

const repeatedEvidence = { id: "commit", label: "CodeCommit revision", reference: "8fa21c7" }

describe("AgentProposal", () => {
  it("shows exact proposal data and an unambiguous non-authorization boundary", () => {
    const card = render(
      <AgentProposal
        outcome={<p>Waiting for a human reviewer.</p>}
        proposal={proposal}
        state={<StateLabel label="Proposed" tone="progress" />}
      />
    )
    expect(card?.tagName).toBe("SECTION")
    expect(card?.textContent).toContain("Agent proposal")
    expect(card?.textContent).toContain("This is an agent proposal. It is not human authorization.")
    expect(card?.textContent).toContain(proposal.capability)
    expect(card?.textContent).toContain(proposal.target)
    expect(card?.textContent).toContain(proposal.expectedRevision)
    expect(card?.textContent).toContain(proposal.impact)
    expect(card?.textContent).toContain(proposal.context)
    expect(card?.querySelectorAll("[data-rly-agent-proposal-evidence] li")).toHaveLength(2)
    expect(card?.querySelector("button")).toBeNull()
  })

  it("uses a rounded-square identity and preserves caller-owned state and outcome slots", () => {
    const card = render(
      <AgentProposal
        outcome={<strong data-outcome="">Needs review</strong>}
        proposal={proposal}
        state={<em>Queued</em>}
      />
    )
    expect(card?.querySelector("[data-rly-agent-proposal-slot='state']")?.textContent).toBe("Queued")
    expect(card?.querySelector("[data-rly-agent-proposal-slot='outcome']")?.textContent).toContain("Needs review")
    expect(card?.querySelector("[role='img']")).toBeNull()
    expect(card?.textContent).toContain("RA")
  })

  it("rejects blank exact fields, missing evidence, and duplicate evidence ids", () => {
    expect(() =>
      renderToStaticMarkup(<AgentProposal outcome="None" proposal={{ ...proposal, capability: " " }} state="Draft" />)
    ).toThrow("AgentProposal capability")
    expect(() =>
      renderToStaticMarkup(<AgentProposal outcome="None" proposal={{ ...proposal, evidence: [] }} state="Draft" />)
    ).toThrow("at least one reference")
    expect(() =>
      renderToStaticMarkup(
        <AgentProposal
          outcome="None"
          proposal={{ ...proposal, evidence: [repeatedEvidence, repeatedEvidence] }}
          state="Draft"
        />
      )
    ).toThrow("evidence ids must be unique")
  })
})
