// Fixtures from packages/herdr-connect/test/usage-view.test.tsx.
import { UsageTab } from "@knpkv/relay-app-design-system"
import type { UsageTabProps } from "@knpkv/herdr-connect"

const noop = () => undefined
const day = 86_400_000
const view: NonNullable<UsageTabProps["usage"]["view"]> = {
  periods: [
    { key: "2026-10-08", start: 0 },
    { key: "2026-10-09", start: day }
  ],
  range: { from: 0, to: 2 * day, bucket: "day" },
  preset: "7d",
  cells: [{ period: 1, id: "claude:claude-opus-5", value: 1_200 }],
  labels: new Map([["claude:claude-opus-5", "Claude claude-opus-5"]]),
  totalTokens: 1_200,
  hosts: [{ host: "SER8", range: { from: 0, to: 2 * day, bucket: "day" }, now: 2 * day, series: [] }],
  notes: ["PI is offline."]
}
const props: UsageTabProps = {
  limits: { problem: null, view: null },
  onHubMachine: false,
  onRangeChange: noop,
  range: "7d",
  usage: { loading: false, problem: null, view }
}

export const Default = () => <UsageTab {...props} />
export const UpdatingRange = () => <UsageTab {...props} range="30d" usage={{ loading: true, problem: null, view }} />
export const NoHosts = () => (
  <UsageTab
    {...props}
    usage={{
      loading: false,
      problem: null,
      view: { ...view, range: null, preset: null, cells: [], totalTokens: 0, hosts: [] }
    }}
  />
)
export const NoTokens = () => (
  <UsageTab {...props} usage={{ loading: false, problem: null, view: { ...view, cells: [], totalTokens: 0 } }} />
)
export const Failed = () => (
  <UsageTab {...props} usage={{ loading: false, problem: "Couldn't load usage.", view: null }} />
)
