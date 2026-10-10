// Fixtures from packages/herdr-connect/test/limits-view.test.tsx.
import { ConnectLimits } from "@knpkv/relay-app-design-system"
import type { ComponentProps } from "react"
import type { ConnectLimits as LimitsComponent } from "@knpkv/herdr-connect"

const view: NonNullable<ComponentProps<typeof LimitsComponent>["view"]> = {
  line: [
    { agent: "claude", tone: "near", text: "Claude 86% 5-hour" },
    { agent: "codex", tone: "unknown", text: "Codex unknown" }
  ],
  hosts: [
    { host: "SER8", now: 1_000 * 3_600_000, latest: [] },
    { host: "PI", now: 1_000 * 3_600_000, latest: [] }
  ],
  notes: ["No reading from MBP (offline)"],
  off: false
}

export const Default = () => <ConnectLimits problem={null} view={view} />
export const SingleHost = () => <ConnectLimits problem={null} view={{ ...view, hosts: view.hosts.slice(0, 1) }} />
export const Failed = () => <ConnectLimits problem="Couldn't load limits." view={null} />
