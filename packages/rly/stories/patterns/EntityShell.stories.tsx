import type { Meta, StoryObj } from "@storybook/react-vite"
import type { CSSProperties, ReactElement, ReactNode } from "react"
import { expect } from "storybook/test"
import { EntityShell } from "../../src/patterns/EntityShell.js"
import { Person } from "../../src/patterns/Person.js"
import type { RlyService } from "../../src/patterns/ServiceMark.js"
import type { RlyFreshnessState } from "../../src/patterns/FreshnessStamp.js"
import type { RlyVerdictTone } from "../../src/patterns/Verdict.js"
import { Button } from "../../src/primitives/Button.js"
import { StatePanel } from "../../src/primitives/StatePanel.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle } from "../primitives/storyStyles.js"

const services = ["codecommit", "codepipeline", "jira", "confluence", "clockify"] satisfies ReadonlyArray<RlyService>
const presentations = [
  { freshness: "current", tone: "positive", verdict: "Ready for review" },
  { freshness: "cached", tone: "progress", verdict: "Deployment running" },
  { freshness: "stale", tone: "critical", verdict: "Cannot ship" },
  { freshness: "missing", tone: "caution", verdict: "Evidence needed" },
  { freshness: "unavailable", tone: "neutral", verdict: "Source unavailable" }
] satisfies ReadonlyArray<{
  readonly freshness: RlyFreshnessState
  readonly tone: RlyVerdictTone
  readonly verdict: string
}>

const catalogStyle: CSSProperties = { display: "grid", gap: "var(--rly-space-80)" }
const compactStyle: CSSProperties = { inlineSize: "100%", maxInlineSize: "320px" }
const slotStyle: CSSProperties = { display: "grid", gap: "var(--rly-space-8)", minWidth: 0 }

const Slot = ({ children, title }: { readonly children: ReactNode; readonly title: string }): ReactElement => (
  <div style={slotStyle}>
    <Text as="h2" variant="card-title">
      {title}
    </Text>
    {children}
  </div>
)

const slotsFor = (service: RlyService) => ({
  actions: <Button size="principal">Review exact action</Button>,
  activity: (
    <Slot title="Activity">
      <Text tone="secondary">A human decision and provider synchronization remain separately attributed.</Text>
    </Slot>
  ),
  agentEntry: (
    <StatePanel
      description="Exact entity context and evidence will be shown before prompting."
      title="Contextual agent"
    />
  ),
  collaborators: (
    <Slot title="People">
      <Person person={{ id: `owner-${service}`, name: "Maya Chen", role: "Entity owner" }} size="compact" />
    </Slot>
  ),
  content: (
    <Slot title="Native content">
      <Text>
        Provider-native fields remain complete in the wide reading column without turning the shell into a provider
        page.
      </Text>
    </Slot>
  ),
  evidence: (
    <Slot title="Evidence">
      <Text tone="secondary">Immutable revision 17 · current normalized snapshot</Text>
    </Slot>
  ),
  facts: (
    <Slot title="Facts">
      <Text tone="secondary">Environment · production</Text>
      <Text tone="secondary">Revision · a84f9d2</Text>
    </Slot>
  ),
  navigation: <a href="/w/engineering/releases/payments">Back to payments release</a>,
  relationships: (
    <Slot title="Relationships">
      <Text tone="secondary">Jira → pull request → pipeline → release · semantic table follows the same order.</Text>
    </Slot>
  )
})

const ServicesCatalog = (): ReactElement => (
  <main style={pageStyle}>
    <div data-entity-shell-services="" style={catalogStyle}>
      {services.map((service, index) => {
        const presentation = presentations[index]
        if (presentation === undefined) throw new Error("EntityShell service presentation is missing")
        return (
          <EntityShell
            {...slotsFor(service)}
            freshness={presentation.freshness}
            freshnessDateTime="2026-07-13T10:18:00Z"
            freshnessTime="Observed at 10:18"
            key={service}
            reason="The application supplied this exact verdict and its supporting explanation."
            service={service}
            title={`${service} entity with a deliberately long, wrap-safe title`}
            tone={presentation.tone}
            verdict={presentation.verdict}
          />
        )
      })}
    </div>
  </main>
)

const CompactForcedColorsCatalog = (): ReactElement => (
  <main style={pageStyle}>
    <div data-entity-shell-compact="" style={compactStyle}>
      <EntityShell
        {...slotsFor("jira")}
        freshness="stale"
        freshnessDateTime="2026-07-13T10:18:00Z"
        freshnessTime="Observed 12 minutes ago"
        reason="Three integration checks failed against the current release head."
        service="jira"
        title="OPS-428 · Production retry policy with complete compact evidence"
        tone="critical"
        verdict="Cannot ship"
      />
    </div>
  </main>
)

const meta = {
  component: EntityShell,
  tags: ["autodocs"],
  title: "Patterns/EntityShell"
} satisfies Meta<typeof EntityShell>

export default meta
type Story = StoryObj<typeof meta>

export const Services: Story = {
  args: {
    actions: "Actions",
    agentEntry: "Agent entry",
    collaborators: "Collaborators",
    content: "Content",
    freshness: "current",
    reason: "Supplied reason",
    relationships: "Relationships",
    service: "jira",
    title: "Entity title",
    tone: "neutral",
    verdict: "Verdict"
  },
  play: async ({ canvasElement }) => {
    const shells = canvasElement.querySelectorAll("[data-rly-entity-shell]")
    await expect(shells).toHaveLength(5)
    for (const service of services) {
      await expect(canvasElement.querySelector(`[data-rly-service="${service}"]`)).not.toBeNull()
    }
    for (const shell of shells) {
      await expect(shell.querySelectorAll("[data-rly-entity-shell-slot]")).toHaveLength(10)
    }
    canvasElement.dataset.entityShellServicesPlayComplete = "true"
  },
  render: () => <ServicesCatalog />
}

export const CompactForcedColors: Story = {
  args: {
    actions: "Actions",
    agentEntry: "Agent entry",
    collaborators: "Collaborators",
    content: "Content",
    freshness: "stale",
    reason: "Supplied reason",
    relationships: "Relationships",
    service: "jira",
    title: "Entity title",
    tone: "critical",
    verdict: "Cannot ship"
  },
  globals: { forcedColors: "active", viewport: { isRotated: false, value: "mobile1" } },
  play: async ({ canvas, canvasElement }) => {
    const compact = canvasElement.querySelector<HTMLElement>("[data-entity-shell-compact]")
    if (compact === null) throw new Error("EntityShell compact boundary did not mount")
    await expect(compact.scrollWidth).toBeLessThanOrEqual(compact.clientWidth)
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("OPS-428")
    await expect(canvas.getByText("Cannot ship")).toBeVisible()
    await expect(compact.querySelectorAll("[data-rly-entity-shell-slot]")).toHaveLength(10)
    canvasElement.dataset.entityShellCompactPlayComplete = "true"
  },
  render: () => <CompactForcedColorsCatalog />
}
