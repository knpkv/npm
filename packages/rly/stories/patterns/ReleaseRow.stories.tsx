import type { Meta, StoryObj } from "@storybook/react-vite"
import { type CSSProperties, type ReactElement, useState } from "react"
import { expect, userEvent } from "storybook/test"
import type { RlyReleasePresentation, RlyReleaseState } from "../../src/patterns/ReleasePresentation.js"
import { ReleaseRow } from "../../src/patterns/ReleaseRow.js"
import { Button } from "../../src/primitives/Button.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle, stackStyle } from "../primitives/storyStyles.js"

const catalogStyle: CSSProperties = { ...pageStyle, gap: "var(--rly-space-16)", paddingInline: 0 }
const headingStyle: CSSProperties = { ...stackStyle, paddingInline: "var(--rly-space-24)" }

const stateDetails: Readonly<
  Record<RlyReleaseState, Pick<RlyReleasePresentation, "freshness" | "reason" | "tone" | "verdict">>
> = {
  blocked: {
    freshness: "unavailable",
    reason: "Production evidence is unavailable and the required approval has not been recorded.",
    tone: "critical",
    verdict: "Blocked"
  },
  ready: {
    freshness: "current",
    reason: "All required evidence is current and the production approver is assigned.",
    tone: "positive",
    verdict: "Ready to deploy"
  },
  deploying: {
    freshness: "current",
    reason: "The production pipeline is actively delivering the caller-selected artifact.",
    tone: "progress",
    verdict: "Deploying"
  },
  building: {
    freshness: "cached",
    reason: "An immutable artifact is still being assembled for verification.",
    tone: "progress",
    verdict: "Building"
  },
  shipped: {
    freshness: "current",
    reason: "The selected artifact is live and the supplied post-deployment checks passed.",
    tone: "positive",
    verdict: "Shipped"
  },
  held: {
    freshness: "stale",
    reason: "The release owner intentionally paused delivery while cached evidence is reviewed.",
    tone: "caution",
    verdict: "Held for review"
  }
}

const releaseFor = (state: RlyReleaseState): RlyReleasePresentation => ({
  algorithm: "rly-relay-v1",
  approver: { id: `approver-${state}`, name: "Dev Shah", role: "Production approver" },
  codename: `${state[0]?.toUpperCase() ?? ""}${state.slice(1)} Finch`,
  facts: [
    { id: "commit", label: "Commit", value: `8fa21c7-${state}` },
    { id: "target", label: "Target", value: "production-eu-west-1" },
    { id: "changes", label: "Changes", value: "14 files" }
  ],
  freshness: stateDetails[state].freshness,
  freshnessDateTime: "2026-07-13T09:42:00Z",
  freshnessTime: "09:42 UTC",
  id: `release-${state}`,
  owner: { id: `owner-${state}`, name: "Mara Bell", role: "Release owner" },
  reason: stateDetails[state].reason,
  state,
  symbolIndices: [2, 7, 13],
  tone: stateDetails[state].tone,
  verdict: stateDetails[state].verdict,
  version: `v2.4.${state.length}`
})

const sixStates = [
  "blocked",
  "ready",
  "deploying",
  "building",
  "shipped",
  "held"
] satisfies ReadonlyArray<RlyReleaseState>

const SixStateCatalog = (): ReactElement => {
  const [previewed, setPreviewed] = useState("No release previewed.")
  return (
    <main style={catalogStyle}>
      <div style={headingStyle}>
        <Text as="h1" variant="section-title">
          Release dossier rows
        </Text>
        <Text tone="secondary">Six caller-owned outcomes share one color-independent information hierarchy.</Text>
        <Text aria-live="polite" data-release-row-status="" role="status" tone="secondary">
          {previewed}
        </Text>
      </div>
      {sixStates.map((state) => (
        <ReleaseRow
          agentEntry={<Button size="compact">Ask agent</Button>}
          key={state}
          onPreview={() => setPreviewed(`Preview requested for ${state}.`)}
          release={releaseFor(state)}
        />
      ))}
    </main>
  )
}

const CompactCatalog = (): ReactElement => (
  <main data-release-row-compact="" style={catalogStyle}>
    <div style={headingStyle}>
      <Text as="h1" variant="section-title">
        Compact release dossier
      </Text>
    </div>
    <ReleaseRow
      agentEntry={<Button size="compact">Ask release agent</Button>}
      onPreview={() => undefined}
      previewLabel="Preview the complete production release"
      release={{
        ...releaseFor("held"),
        codename: "The Deliberately Long Copper Finch Identity",
        facts: [
          { id: "commit", label: "Commit", value: "8fa21c71af41ed69947f9b9f8c7cd4a8d614a760" },
          {
            id: "target",
            label: "Target",
            value: "production-eu-west-1/customer-facing-release-control-plane"
          },
          { id: "changes", label: "Changes", value: "One hundred and forty-seven caller-supplied files" }
        ],
        reason:
          "The release owner intentionally held this unusually long presentation while every attached evidence source is checked against the final production artifact."
      }}
    />
  </main>
)

const meta = {
  component: ReleaseRow,
  tags: ["autodocs"],
  title: "Patterns/ReleaseRow"
} satisfies Meta<typeof ReleaseRow>

export default meta
type Story = StoryObj<typeof meta>

export const SixStates: Story = {
  args: { onPreview: () => undefined, release: releaseFor("ready") },
  play: async ({ canvas, canvasElement }) => {
    const rows = canvasElement.querySelectorAll("[data-rly-release-state]")
    await expect(rows).toHaveLength(6)
    await expect([...rows].map((row) => row.getAttribute("data-rly-release-state"))).toEqual(sixStates)
    for (const state of sixStates) await expect(canvas.getByText(stateDetails[state].verdict)).toBeVisible()
    await userEvent.click(canvas.getAllByRole("button", { name: "Preview release" })[1]!)
    await expect(canvas.getByRole("status")).toHaveTextContent("Preview requested for ready.")
    canvasElement.dataset.releaseRowSixStatesPlayComplete = "true"
  },
  render: () => <SixStateCatalog />
}

export const Compact: Story = {
  args: { onPreview: () => undefined, release: releaseFor("held") },
  globals: { forcedColors: "active", theme: "dark", viewport: { isRotated: false, value: "mobile1" } },
  play: async ({ canvas, canvasElement }) => {
    const catalog = canvasElement.querySelector<HTMLElement>("[data-release-row-compact]")
    if (catalog === null) throw new Error("ReleaseRow compact catalog did not render")
    await expect(catalog.scrollWidth).toBeLessThanOrEqual(catalog.clientWidth)
    await expect(canvas.getByText("The Deliberately Long Copper Finch Identity")).toBeVisible()
    await expect(canvas.getByRole("button", { name: "Preview the complete production release" })).toBeVisible()
    canvasElement.dataset.releaseRowCompactPlayComplete = "true"
  },
  render: () => <CompactCatalog />
}
