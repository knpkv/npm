/** Stacks pages: the host's alchemy stacks and one stack's state and published plan. Read-only. @module */
import type { PlanState, StackDetailResult, StackId, StacksOverviewResult } from "@knpkv/alchemy-console/host"
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

type ReadOutcome<A> = Result.Result<A, StacksReadFailed>

/**
 * Runs `read` while the page is active; a new `generation` reads again and leaving the page aborts it.
 * `read` must keep its identity across renders (memoise it), or every render reads again.
 */
const useRead = <A,>(read: Effect.Effect<A, StacksReadFailed> | null, active: boolean, generation: number) => {
  const [outcome, setOutcome] = useState<ReadOutcome<A> | null>(null)
  useEffect(() => {
    if (!active || read === null) return
    setOutcome(null)
    const controller = new AbortController()
    void Effect.runPromise(Effect.result(read), { signal: controller.signal }).then((next) => {
      if (!controller.signal.aborted) setOutcome(next)
    })
    return () => controller.abort()
  }, [read, active, generation])
  return outcome
}

const unavailableCopy = (reason: "not_configured" | "other_host" | "unavailable", host: string | null) =>
  reason === "not_configured"
    ? "Stacks aren’t available on this hub. Set RELAY_STACKS_HOST to the host that holds the AWS profiles."
    : reason === "other_host"
      ? `Stacks are read on ${host ?? "another host"}. Open this hub on that host to see them.`
      : `Stacks couldn’t start on ${host ?? "this host"}. Check its AWS configuration and state root, then reload.`

const Unavailable = ({
  host,
  reason
}: {
  readonly reason: "not_configured" | "other_host" | "unavailable"
  readonly host: string | null
}): ReactElement => <StatePanel title="Stacks unavailable" description={unavailableCopy(reason, host)} tone="neutral" />

const overviewState = (
  exit: ReadOutcome<StacksOverviewResult> | null,
  checkedAt: string
):
  | StackListState
  | {
      readonly _tag: "Unavailable"
      readonly reason: "not_configured" | "other_host" | "unavailable"
      readonly host: string | null
    } => {
  if (exit === null) return { _tag: "Loading" }
  if (Result.isFailure(exit)) return { _tag: "Failed", reason: "transport" }
  const result = exit.success
  return result._tag === "Ready"
    ? { _tag: "Ready", list: result.list, checkedAt }
    : result._tag === "Failed"
      ? { _tag: "Failed", reason: result.reason }
      : result
}

const OverviewPage = ({
  mount,
  reads
}: {
  readonly reads: StacksModuleReads
  readonly mount: ModulePageMount
}): ReactElement => {
  const [generation, setGeneration] = useState(0)
  const exit = useRead(reads.overview, mount.active, generation)
  const state = overviewState(exit, DateTime.formatIso(DateTime.nowUnsafe()))
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

const detailState = (
  exit: ReadOutcome<StackDetailResult> | null,
  known: boolean
):
  | StackDetailState
  | {
      readonly _tag: "Unavailable"
      readonly reason: "not_configured" | "other_host" | "unavailable"
      readonly host: string | null
    } => {
  if (!known) return { _tag: "NotFound" }
  if (exit === null) return { _tag: "Loading" }
  if (Result.isFailure(exit)) {
    return exit.failure.reason === "not_found" ? { _tag: "NotFound" } : { _tag: "Failed", reason: "transport" }
  }
  const result = exit.success
  return result._tag === "Ready"
    ? { _tag: "Ready", stack: result.detail.state }
    : result._tag === "Failed"
      ? { _tag: "Failed", reason: result.reason }
      : result
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
  const exit = useRead(stackRead, mount.active, generation)
  const planExit = useRead(planRead, mount.active, planGeneration)
  const state = detailState(exit, stackId !== null)
  if (state._tag === "Unavailable") return <Unavailable reason={state.reason} host={state.host} />
  const planState: PlanState | undefined =
    planExit === null
      ? { _tag: "Loading" }
      : Result.isFailure(planExit)
        ? { _tag: "Unreachable" }
        : planExit.success._tag === "Ready"
          ? planExit.success.plan
          : { _tag: "NotConnected" }
  const href = (next: StackTab) =>
    moduleHref(stacksModule, "stack", new URLSearchParams({ id: stackId ?? "", view: next }))
  return (
    <StackDetailView
      copy={copy}
      onReadAgain={() => setGeneration((count) => count + 1)}
      onReadPlanAgain={() => setPlanGeneration((count) => count + 1)}
      onTabChange={(next) => mount.navigate(href(next), "replace", null)}
      planState={planState}
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
