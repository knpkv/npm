/** Stacks pages: the host's alchemy stacks and one stack's state and published plan. Read-only. @module */
import type {
  PlanState,
  StackDetailResult,
  StackId,
  StackPlanResult,
  StacksOverviewResult,
  StacksUnavailable
} from "@knpkv/alchemy-console/host"
import {
  StackDetailView,
  type StackDetailState,
  StackListView,
  type StackListState,
  type StackTab
} from "@knpkv/alchemy-console/views"
import { StatePanel } from "@knpkv/rly/primitives"
import { StackId as StackIdSchema } from "@knpkv/alchemy-console/host"
import { DateTime, Effect, Result, Schema } from "effect"
import { type ReactElement, useEffect, useMemo, useState } from "react"
import { ShellIcon } from "./internal/shell-icon.js"
import { moduleHref, type ModulePageMount, type ModuleViews, stacksModule } from "./modules.js"
import type { StacksModuleReads, StacksReadFailed } from "./stacks-client.js"

const copy = { product: "Stacks", signInInstruction: "Reload this page to sign in again." }
const tabs: ReadonlyArray<StackTab> = ["resources", "outputs", "state", "plan"]
const isTab = (value: string | null): value is StackTab => tabs.some((tab) => tab === value)
const decodeStackId = Schema.decodeUnknownOption(StackIdSchema)

/** One settled read and when it settled. */
interface Settled<A> {
  readonly result: Result.Result<A, StacksReadFailed>
  readonly at: string
}

/**
 * Runs `read` while the page is active; a new `generation` reads again and leaving the page aborts it.
 * `read` must keep its identity across renders (memoise it), or every render reads again. The time is
 * stamped when the read settles, so a later re-render keeps the time the data was read.
 */
const useRead = <A,>(read: Effect.Effect<A, StacksReadFailed> | null, active: boolean, generation: number) => {
  const [settled, setSettled] = useState<Settled<A> | null>(null)
  useEffect(() => {
    if (!active || read === null) return
    setSettled(null)
    const controller = new AbortController()
    void Effect.runPromise(Effect.result(read), { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) setSettled({ result, at: DateTime.formatIso(DateTime.nowUnsafe()) })
    })
    return () => controller.abort()
  }, [read, active, generation])
  return settled
}

const unavailableCopy = (reason: StacksUnavailable["reason"], host: string | null): string => {
  switch (reason) {
    case "not_configured":
      return "Stacks aren’t available on this hub. Set RELAY_STACKS_HOST to the host that holds the AWS profiles."
    case "other_host":
      return `Stacks are read on ${host ?? "another host"}. Open this hub on that host to see them.`
    case "not_hub":
      return `RELAY_STACKS_HOST names ${host ?? "this host"}, but this host isn’t the hub. Stacks are read by the hub only.`
    case "unavailable":
      return `Stacks couldn’t start on ${host ?? "this host"}. Check its AWS configuration and state root, then reload.`
  }
}

const Unavailable = ({ host, reason }: Omit<StacksUnavailable, "_tag">): ReactElement => (
  <StatePanel title="Stacks unavailable" description={unavailableCopy(reason, host)} tone="neutral" />
)

/** A failed transport read: an expired hub session asks to sign in again; anything else is a transport failure. */
type TransportFailure =
  | { readonly _tag: "Unauthorized"; readonly reason: "session" }
  | { readonly _tag: "Failed"; readonly reason: "transport" }

const transportFailure = (failure: StacksReadFailed): TransportFailure =>
  failure.reason === "unauthorized"
    ? { _tag: "Unauthorized", reason: "session" }
    : { _tag: "Failed", reason: "transport" }

const overviewState = (read: Settled<StacksOverviewResult> | null): StackListState | StacksUnavailable => {
  if (read === null) return { _tag: "Loading" }
  if (Result.isFailure(read.result)) return transportFailure(read.result.failure)
  const result = read.result.success
  switch (result._tag) {
    case "Ready":
      return { _tag: "Ready", list: result.list, checkedAt: read.at }
    case "Failed":
      return { _tag: "Failed", reason: result.reason }
    case "Unavailable":
      return result
  }
}

const OverviewPage = ({
  mount,
  reads
}: {
  readonly reads: StacksModuleReads
  readonly mount: ModulePageMount
}): ReactElement => {
  const [generation, setGeneration] = useState(0)
  const state = overviewState(useRead(reads.overview, mount.active, generation))
  if (state._tag === "Unavailable") return <Unavailable reason={state.reason} host={state.host} />
  return (
    <StackListView
      copy={copy}
      onReadAgain={() => setGeneration((count) => count + 1)}
      stackHref={(stack) => moduleHref(stacksModule, "stack", new URLSearchParams({ id: stack.id }))}
      state={state}
    />
  )
}

const detailState = (read: Settled<StackDetailResult> | null, known: boolean): StackDetailState | StacksUnavailable => {
  if (!known) return { _tag: "NotFound" }
  if (read === null) return { _tag: "Loading" }
  if (Result.isFailure(read.result)) {
    return read.result.failure.reason === "not_found" ? { _tag: "NotFound" } : transportFailure(read.result.failure)
  }
  const result = read.result.success
  switch (result._tag) {
    case "Ready":
      return { _tag: "Ready", stack: result.detail.state }
    case "Failed":
      return { _tag: "Failed", reason: result.reason }
    case "Unavailable":
      return result
  }
}

const planState = (read: Settled<StackPlanResult> | null): PlanState => {
  if (read === null) return { _tag: "Loading" }
  if (Result.isFailure(read.result)) return { _tag: "Unreachable" }
  return read.result.success._tag === "Ready" ? read.result.success.plan : { _tag: "NotConnected" }
}

const StackPage = ({
  mount,
  reads,
  search
}: {
  readonly reads: StacksModuleReads
  readonly search: URLSearchParams
  readonly mount: ModulePageMount
}): ReactElement => {
  const id = decodeStackId(search.get("id"))
  const stackId: StackId | null = id._tag === "Some" ? id.value : null
  const view = search.get("view")
  const tab: StackTab = isTab(view) ? view : "resources"
  const [generation, setGeneration] = useState(0)
  const [planGeneration, setPlanGeneration] = useState(0)
  const stackRead = useMemo(() => (stackId === null ? null : reads.stack(stackId)), [reads, stackId])
  const planRead = useMemo(
    () => (stackId === null || tab !== "plan" ? null : reads.plan(stackId)),
    [reads, stackId, tab]
  )
  const state = detailState(useRead(stackRead, mount.active, generation), stackId !== null)
  const plan = planState(useRead(planRead, mount.active, planGeneration))
  if (state._tag === "Unavailable") return <Unavailable reason={state.reason} host={state.host} />
  const href = (next: StackTab) =>
    moduleHref(stacksModule, "stack", new URLSearchParams({ id: stackId ?? "", view: next }))
  return (
    <StackDetailView
      copy={copy}
      onReadAgain={() => setGeneration((count) => count + 1)}
      onReadPlanAgain={() => setPlanGeneration((count) => count + 1)}
      onTabChange={(next) => mount.navigate(href(next), "replace", null)}
      planState={plan}
      resourceHref={() => href("resources")}
      state={state}
      tab={tab}
    />
  )
}

/** Reads run only while their page is active and visible in the shell. */
export const makeStacksModuleViews = (content: {
  readonly reads: StacksModuleReads
}): ModuleViews<typeof stacksModule> => ({
  descriptor: stacksModule,
  navigationIcon: <ShellIcon name="stacks" />,
  pages: {
    overview: (_search, mount) => <OverviewPage mount={mount} reads={content.reads} />,
    stack: (search, mount) => <StackPage mount={mount} reads={content.reads} search={search} />
  }
})
