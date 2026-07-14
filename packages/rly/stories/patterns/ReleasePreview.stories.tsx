import type { Meta, StoryObj } from "@storybook/react-vite"
import { type CSSProperties, type ReactElement, useState } from "react"
import { expect, userEvent, waitFor } from "storybook/test"
import { PortalProvider } from "../../src/foundations/PortalProvider.js"
import { EvidenceStamp } from "../../src/patterns/EvidenceStamp.js"
import { PeopleStrip } from "../../src/patterns/PeopleStrip.js"
import type { RlyPerson } from "../../src/patterns/Person.js"
import type { RlyReleasePresentation } from "../../src/patterns/ReleasePresentation.js"
import { ReleasePreview } from "../../src/patterns/ReleasePreview.js"
import { StageRail, type RlyStage } from "../../src/patterns/StageRail.js"
import { Button } from "../../src/primitives/Button.js"
import { Surface } from "../../src/primitives/Surface.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle, rowStyle, stackStyle } from "../primitives/storyStyles.js"

const slotStackStyle: CSSProperties = { ...stackStyle, maxWidth: "none" }

const expectInInitialViewport = async (element: HTMLElement): Promise<void> => {
  const view = element.ownerDocument.defaultView
  if (view === null) throw new Error("ReleasePreview viewport was unavailable")
  await waitFor(() => {
    const bounds = element.getBoundingClientRect()
    expect(bounds.top).toBeGreaterThanOrEqual(0)
    expect(bounds.left).toBeGreaterThanOrEqual(0)
    expect(bounds.bottom).toBeLessThanOrEqual(view.innerHeight)
    expect(bounds.right).toBeLessThanOrEqual(view.innerWidth)
  })
}

const release = {
  algorithm: "rly-relay-v1",
  approver: { id: "dev", name: "Dev Shah", role: "Production approver" },
  codename: "Copper Finch",
  facts: [
    { id: "commit", label: "Commit", value: "8fa21c7" },
    { id: "target", label: "Target", value: "production-eu-west-1" },
    { id: "changes", label: "Changes", value: "14 files" },
    { id: "evidence", label: "Evidence", value: "3 attached checks" }
  ],
  freshness: "current",
  freshnessDateTime: "2026-07-13T09:42:00Z",
  freshnessTime: "09:42 UTC",
  id: "release-240",
  owner: { id: "mara", name: "Mara Bell", role: "Release owner" },
  reason: "All required evidence is current and the production approver is assigned.",
  state: "ready",
  symbolIndices: [2, 7, 13],
  tone: "positive",
  verdict: "Ready to deploy",
  version: "v2.4.0"
} satisfies RlyReleasePresentation

const compactRelease = {
  algorithm: release.algorithm,
  approver: release.approver,
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
  freshness: release.freshness,
  freshnessDateTime: release.freshnessDateTime,
  freshnessTime: release.freshnessTime,
  id: "release-241",
  reason:
    "Readiness has not been evaluated. Every unusually long caller-supplied evidence reference remains visible while this dossier is reviewed.",
  state: "unknown",
  symbolIndices: release.symbolIndices,
  tone: "neutral",
  verdict: "Readiness not evaluated",
  version: "v2.4.1"
} satisfies RlyReleasePresentation

const stages = [
  { id: "build", name: "Build", state: "Complete", tone: "positive" },
  { id: "verify", name: "Verify", state: "Complete", tone: "positive" },
  { id: "production", name: "Production", state: "Ready", tone: "progress" }
] satisfies ReadonlyArray<RlyStage>

const collaborators = [
  { id: "mara", name: "Mara Bell", role: "Primary release owner" },
  { id: "dev", name: "Dev Shah", role: "Production approver" },
  { id: "avery", name: "Avery Diaz", role: "Pull request reviewer" },
  { id: "casey", name: "Casey Singh", role: "Deployment operator" }
] satisfies ReadonlyArray<RlyPerson>

const primaryAction = <Button variant="primary">Deploy release</Button>
const collaboratorsSlot = (
  <PeopleStrip
    aria-label="Complete release collaborators"
    expanded
    limit={collaborators.length}
    onExpandedChange={() => undefined}
    people={collaborators}
    size="compact"
  />
)
const stageSlot = <StageRail heading="Delivery stages" size="compact" stages={stages} />
const worksetSlot = (
  <Surface as="section" padding="compact">
    <div style={slotStackStyle}>
      <Text as="h2" variant="card-title">
        Release workset
      </Text>
      <Text>Jira RLY-240 · Pull request #184 · production pipeline run 6672</Text>
    </div>
  </Surface>
)
const evidenceSlot = (
  <div style={rowStyle}>
    <EvidenceStamp freshness="current" reference="PR #184 / 8fa21c7" service="codecommit" />
    <EvidenceStamp freshness="cached" reference="RLY-240" service="jira" />
  </div>
)
const agentSlot = (
  <Surface as="aside" padding="compact" tone="secondary">
    <div style={slotStackStyle}>
      <Text as="h2" variant="card-title">
        Release agent
      </Text>
      <Text tone="secondary">Ask about evidence gaps or the supplied production progression.</Text>
      <Button size="compact">Ask release agent</Button>
    </div>
  </Surface>
)

const PreviewInteraction = (): ReactElement => {
  const [open, setOpen] = useState(false)
  const [fullViewCount, setFullViewCount] = useState(0)
  return (
    <PortalProvider>
      <main data-release-preview-background="" style={pageStyle}>
        <div style={stackStyle}>
          <Text as="h1" variant="section-title">
            Release preview interaction
          </Text>
          <Text tone="secondary">Open the controlled dossier while preserving application context.</Text>
          <Button onClick={() => setOpen(true)} variant="primary">
            Preview Copper Finch
          </Button>
          <Text aria-live="polite" data-full-view-status="" role="status" tone="secondary">
            Full view opened {fullViewCount} times.
          </Text>
        </div>
        <ReleasePreview
          agentEntry={agentSlot}
          collaborators={collaboratorsSlot}
          evidence={evidenceSlot}
          onOpenChange={setOpen}
          onOpenFullView={() => setFullViewCount((count) => count + 1)}
          open={open}
          primaryAction={primaryAction}
          release={release}
          stages={stageSlot}
          workset={worksetSlot}
        />
      </main>
    </PortalProvider>
  )
}

const CompactPreview = (): ReactElement => {
  const [open, setOpen] = useState(true)
  return (
    <PortalProvider>
      <main data-release-preview-compact-background="" style={pageStyle}>
        <ReleasePreview
          agentEntry={agentSlot}
          collaborators={collaboratorsSlot}
          evidence={evidenceSlot}
          onOpenChange={setOpen}
          onOpenFullView={() => undefined}
          open={open}
          openFullViewLabel="Open the complete production release view"
          presentation="sheet"
          primaryAction={primaryAction}
          release={compactRelease}
          stages={stageSlot}
          workset={worksetSlot}
        />
      </main>
    </PortalProvider>
  )
}

const ExternalMotionPreview = (): ReactElement => {
  const [entryMotion, setEntryMotion] = useState<"external" | "intrinsic">("external")
  const [open, setOpen] = useState(false)
  return (
    <PortalProvider>
      <style>{`
        [data-rly-dialog-overlay][data-state="open"],
        [role="dialog"][data-state="open"] {
          animation-duration: 10s !important;
        }
      `}</style>
      <main style={pageStyle}>
        <div style={stackStyle}>
          <Text as="h1" variant="section-title">
            Externally orchestrated preview
          </Text>
          <Text tone="secondary">Entry ownership is sampled once and remains stable until this preview closes.</Text>
          <Button onClick={() => setOpen(true)} variant="primary">
            Preview with external motion
          </Button>
        </div>
        <ReleasePreview
          agentEntry={agentSlot}
          collaborators={collaboratorsSlot}
          entryMotion={entryMotion}
          evidence={evidenceSlot}
          onOpenChange={setOpen}
          onOpenFullView={() => undefined}
          open={open}
          primaryAction={
            <Button onClick={() => setEntryMotion("intrinsic")} variant="primary">
              Request intrinsic motion next time
            </Button>
          }
          release={release}
          stages={stageSlot}
          workset={worksetSlot}
        />
      </main>
    </PortalProvider>
  )
}

const meta = {
  component: ReleasePreview,
  tags: ["autodocs"],
  title: "Patterns/ReleasePreview"
} satisfies Meta<typeof ReleasePreview>

export default meta
type Story = StoryObj<typeof meta>

export const Interaction: Story = {
  args: {
    agentEntry: agentSlot,
    collaborators: collaboratorsSlot,
    evidence: evidenceSlot,
    onOpenChange: () => undefined,
    onOpenFullView: () => undefined,
    open: false,
    primaryAction,
    release,
    stages: stageSlot,
    workset: worksetSlot
  },
  play: async ({ canvas, canvasElement }) => {
    const trigger = canvas.getByRole("button", { name: "Preview Copper Finch" })
    await userEvent.click(trigger)
    const dialog = canvas.getByRole("dialog", { name: "Release preview: v2.4.0 Copper Finch" })
    const summary = canvasElement.querySelector<HTMLElement>("[data-rly-release-preview-summary]")
    if (summary === null) throw new Error("ReleasePreview summary did not render")
    await waitFor(() => expect(dialog).toBeVisible())
    await expect(summary).toHaveFocus()
    const fullViewAction = canvas.getByRole("button", { name: "Open full view" })
    await expectInInitialViewport(fullViewAction)
    await expect(
      [...dialog.querySelectorAll("[data-rly-release-preview-slot]")].map((slot) =>
        slot.getAttribute("data-rly-release-preview-slot")
      )
    ).toEqual(["collaborators", "primary-action", "stages", "workset", "evidence", "agent-entry"])
    await userEvent.tab()
    await expect(canvas.getByRole("button", { name: "Deploy release" })).toHaveFocus()
    await userEvent.click(fullViewAction)
    await expect(canvas.getByRole("status")).toHaveTextContent("Full view opened 1 times.")
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(trigger).toHaveFocus())
    await expect(canvas.queryByRole("dialog", { name: "Release preview: v2.4.0 Copper Finch" })).not.toBeInTheDocument()
    canvasElement.dataset.releasePreviewInteractionPlayComplete = "true"
  },
  render: () => <PreviewInteraction />
}

export const ExternalMotionOwnership: Story = {
  args: {
    agentEntry: agentSlot,
    collaborators: collaboratorsSlot,
    entryMotion: "external",
    evidence: evidenceSlot,
    onOpenChange: () => undefined,
    onOpenFullView: () => undefined,
    open: false,
    primaryAction,
    release,
    stages: stageSlot,
    workset: worksetSlot
  },
  play: async ({ canvas, canvasElement }) => {
    const trigger = canvas.getByRole("button", { name: "Preview with external motion" })
    await userEvent.click(trigger)
    const dialog = canvas.getByRole("dialog", { name: "Release preview: v2.4.0 Copper Finch" })
    const layer = canvasElement.querySelector<HTMLElement>("[data-rly-dialog-layer]")
    const overlay = canvasElement.querySelector<HTMLElement>("[data-rly-dialog-overlay]")
    if (layer === null || overlay === null) throw new Error("External preview modal layer did not render")
    await expect(layer).toHaveAttribute("data-rly-dialog-entry-motion", "external")
    await expect(getComputedStyle(dialog).animationName).toBe("none")
    await expect(getComputedStyle(overlay).animationName).toBe("none")

    await userEvent.click(canvas.getByRole("button", { name: "Request intrinsic motion next time" }))
    await expect(layer).toHaveAttribute("data-rly-dialog-entry-motion", "external")
    await expect(getComputedStyle(dialog).animationName).toBe("none")
    await expect(dialog).toBeVisible()

    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(trigger).toHaveFocus())
    await userEvent.click(trigger)
    const reopenedDialog = canvas.getByRole("dialog", { name: "Release preview: v2.4.0 Copper Finch" })
    const reopenedLayer = canvasElement.querySelector<HTMLElement>("[data-rly-dialog-layer]")
    if (reopenedLayer === null) throw new Error("Reopened preview modal layer did not render")
    await expect(reopenedLayer).toHaveAttribute("data-rly-dialog-entry-motion", "intrinsic")
    await expect(getComputedStyle(reopenedDialog).animationName).toMatch(/dialog-enter$/)
    canvasElement.dataset.releasePreviewExternalMotionPlayComplete = "true"
  },
  render: () => <ExternalMotionPreview />
}

export const CompactForcedColors: Story = {
  args: {
    agentEntry: agentSlot,
    collaborators: collaboratorsSlot,
    evidence: evidenceSlot,
    onOpenChange: () => undefined,
    onOpenFullView: () => undefined,
    open: true,
    primaryAction,
    release,
    stages: stageSlot,
    workset: worksetSlot
  },
  globals: { forcedColors: "active", theme: "dark", viewport: { isRotated: false, value: "mobile1" } },
  play: async ({ canvas, canvasElement }) => {
    const dialog = canvas.getByRole("dialog", {
      name: "Release preview: v2.4.1 The Deliberately Long Copper Finch Identity"
    })
    const summary = canvasElement.querySelector<HTMLElement>("[data-rly-release-preview-summary]")
    if (summary === null) throw new Error("ReleasePreview compact summary did not render")
    await waitFor(() => expect(dialog).toBeVisible())
    await expect(summary).toHaveFocus()
    await expect(dialog).toHaveAttribute("data-rly-sheet-side", "end")
    await expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth)
    await expect(canvas.getByText("The Deliberately Long Copper Finch Identity")).toBeVisible()
    await expect(canvas.getByText("Readiness not evaluated")).toBeVisible()
    await expect(canvas.getByText("Unassigned")).toBeVisible()
    const fullViewAction = canvas.getByRole("button", { name: "Open the complete production release view" })
    await expect(fullViewAction).toBeVisible()
    await expectInInitialViewport(fullViewAction)
    await expect(canvas.getByRole("list", { name: "Complete release collaborators" })).toBeVisible()
    await expect(canvasElement.querySelectorAll("[data-rly-release-preview-slot]")).toHaveLength(6)
    canvasElement.dataset.releasePreviewCompactPlayComplete = "true"
  },
  render: () => <CompactPreview />
}
