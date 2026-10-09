/**
 * The hub's Usage tab, wired: the chosen range (remembered in this browser), the fleet's usage for it
 * in this browser's time zone, refreshed every five minutes, and the fleet's limits, refreshed every
 * minute. Polls run only while the tab is mounted.
 *
 * @module
 */
import { useAtom, useAtomMount, useAtomValue } from "@effect/atom-react"
import { BrowserHttpClient } from "@effect/platform-browser"
import type { UsagePreset } from "@knpkv/agent-usage/usage"
import { Effect, Schedule } from "effect"
import * as Atom from "effect/reactivity/Atom"
import type { ReactElement } from "react"
import { limitsState, loadLimits, loadUsage, usageState } from "./fleet-reads-client.js"
import { USAGE_RANGES, UsageTab } from "./usage-view.js"

const browserRuntime = Atom.runtime(BrowserHttpClient.layerFetch)

const RANGE_KEY = "herdr.usage.range"

/** The range this browser chose last time, else a week. Storage can be absent or refuse; neither is an error here. */
const rememberedRange = (): UsagePreset => {
  try {
    const stored = window.localStorage.getItem(RANGE_KEY)
    return USAGE_RANGES.find((range) => range === stored) ?? "7d"
  } catch {
    return "7d"
  }
}

const rememberRange = (range: UsagePreset): void => {
  try {
    window.localStorage.setItem(RANGE_KEY, range)
  } catch {
    // Not remembered across visits; the tab still switches.
  }
}

/** The page is open on the machine serving it, so agent-usage's loopback page is reachable from here. */
const onLoopback = (): boolean => ["127.0.0.1", "localhost", "[::1]"].includes(window.location.hostname)

/** This browser's zone: every host is asked for periods local to it, so their days line up. */
const viewerTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

export const makeUsageAtoms = () => {
  const range = Atom.make<UsagePreset>(rememberedRange())
  const usage = browserRuntime.atom((get) => loadUsage({ range: get(range), timeZone: viewerTimeZone() }))
  const limits = browserRuntime.atom(loadLimits)
  return {
    range,
    usage,
    // agent-usage's history moves slowly and hostd caches each range for five minutes.
    usagePoll: browserRuntime.atom(Atom.refresh(usage).pipe(Effect.repeat(Schedule.spaced("5 minutes")))),
    limits,
    // Each host rereads its limits at most every 30 seconds; a minute keeps the page within two reads.
    limitsPoll: browserRuntime.atom(Atom.refresh(limits).pipe(Effect.repeat(Schedule.spaced("60 seconds"))))
  }
}

export type UsageAtoms = ReturnType<typeof makeUsageAtoms>

/** The Usage tab for the hub: mount it only while the tab shows, so its polls stop when it doesn't. */
export const UsageSurface = ({ atoms }: { readonly atoms: UsageAtoms }): ReactElement => {
  useAtomMount(atoms.usagePoll)
  useAtomMount(atoms.limitsPoll)
  const [range, setRange] = useAtom(atoms.range)
  const now = Date.now()
  return (
    <UsageTab
      limits={limitsState(useAtomValue(atoms.limits), now)}
      onHubMachine={onLoopback()}
      onRangeChange={(next) => {
        rememberRange(next)
        setRange(next)
      }}
      range={range}
      usage={usageState(useAtomValue(atoms.usage), now)}
    />
  )
}
