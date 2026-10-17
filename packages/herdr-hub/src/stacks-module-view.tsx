/**
 * Stacks pages, Hub-native: the host's alchemy stacks in one table, and one stack's activity and state.
 * Read-only: the only actions are links to the CI run that published a plan. @module
 */
import type {
  PlanState,
  StackDetailResult,
  StackId,
  StackPlanResult,
  StacksOverviewResult,
  StackSummary,
  StacksUnavailable
} from "@knpkv/alchemy-console/host"
import { StackId as StackIdSchema } from "@knpkv/alchemy-console/host"
import { PlanView, StackOutputsView, StackResourcesView, StackStateTree } from "@knpkv/alchemy-console/views"
import { Icon, type RlyIconName } from "@knpkv/rly/foundations"
import { Notice, Skeleton, Tabs } from "@knpkv/rly/primitives"
import { Cause, Effect, Exit, Result, Schema } from "effect"
import { type ReactElement, type ReactNode, useEffect, useId, useMemo, useState } from "react"
import { ShellIcon } from "./internal/shell-icon.js"
import { moduleHref, type ModulePageMount, type ModuleViews, stacksModule } from "./modules.js"
import type { StacksModuleReads, StacksReadFailed } from "./stacks-client.js"

const decodeStackId = Schema.decodeUnknownOption(StackIdSchema)
type StackTab = "resources" | "state" | "outputs" | "plan"
const stackTabs: ReadonlyArray<StackTab> = ["resources", "state", "outputs", "plan"]
const isStackTab = (value: string | null): value is StackTab => stackTabs.some((tab) => tab === value)
const tabLabels = {
  resources: "Resources",
  state: "State",
  outputs: "Outputs",
  plan: "Plan"
} satisfies Readonly<Record<StackTab, string>>

/**
 * Runs `read` while the page is active; a new `generation` reads again and leaving the page aborts it.
 * `read` must keep its identity across renders (memoise it), or every render reads again.
 */
const useRead = <A,>(read: Effect.Effect<A, StacksReadFailed> | null, active: boolean, generation: number) => {
  const [settled, setSettled] = useState<Result.Result<A, StacksReadFailed> | null>(null)
  useEffect(() => {
    if (!active || read === null) return
    setSettled(null)
    const controller = new AbortController()
    runUntilAborted(
      Effect.result(read).pipe(Effect.tap((result) => Effect.sync(() => setSettled(result)))),
      controller.signal
    )
    return () => controller.abort()
  }, [read, active, generation])
  return settled
}

/**
 * Runs a page read until `signal` aborts. Leaving the page interrupts it quietly; a defect still surfaces
 * as an unhandled rejection rather than being swallowed.
 */
const runUntilAborted = (effect: Effect.Effect<unknown>, signal: AbortSignal): void => {
  void Effect.runPromiseExit(effect, { signal }).then((exit) => {
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) throw Cause.squash(exit.cause)
  })
}

/** Plan reads reach the CI provider's API; the overview keeps at most this many in flight. */
const planReadConcurrency = 3

/** Each listed stack's last plan, read a few at a time while the page is active. Unread rows are absent. */
const usePlans = (
  reads: StacksModuleReads,
  stacks: ReadonlyArray<StackSummary>,
  active: boolean
): ReadonlyMap<StackId, PlanState> => {
  const [plans, setPlans] = useState<ReadonlyMap<StackId, PlanState>>(new Map())
  useEffect(() => {
    if (!active) return
    setPlans(new Map())
    const controller = new AbortController()
    runUntilAborted(
      Effect.forEach(
        stacks,
        (stack) =>
          Effect.result(reads.plan(stack.id)).pipe(
            Effect.tap((result) =>
              Effect.sync(() =>
                setPlans((previous) => new Map(previous).set(stack.id, planOf(result) ?? { _tag: "Loading" }))
              )
            )
          ),
        { concurrency: planReadConcurrency, discard: true }
      ),
      controller.signal
    )
    return () => controller.abort()
  }, [reads, stacks, active])
  return plans
}

type CardTone = "neutral" | "caution" | "critical"
const toneGlyph = { neutral: "minus", caution: "clock", critical: "alert" } satisfies Readonly<
  Record<CardTone, RlyIconName>
>

/** A compact state card: a toned eyebrow, the fact as a title, and what to do about it. */
const StateCard = ({
  children,
  eyebrow,
  title,
  tone
}: {
  readonly tone: CardTone
  readonly eyebrow: string
  readonly title: string
  readonly children?: ReactNode
}): ReactElement => (
  <section className="stacks-state" data-tone={tone}>
    <p className="stacks-state-eyebrow">
      <Icon decorative name={toneGlyph[tone]} size="small" />
      {eyebrow}
    </p>
    <h2>{title}</h2>
    {children === undefined ? null : <p>{children}</p>}
  </section>
)

const Setting = ({ children }: { readonly children: string }): ReactElement => (
  <code className="stacks-mono">{children}</code>
)

/** Why a read didn't produce data, as the page says it. */
type Problem =
  | { readonly _tag: "Unavailable"; readonly reason: StacksUnavailable["reason"]; readonly host: string | null }
  | { readonly _tag: "SignIn" }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "Failed"; readonly reason: string }

const problemFromFailure = (failure: StacksReadFailed): Problem =>
  failure.reason === "unauthorized"
    ? { _tag: "SignIn" }
    : failure.reason === "not_found"
      ? { _tag: "NotFound" }
      : { _tag: "Failed", reason: failure.reason }

const UnavailableCard = ({
  host,
  reason
}: {
  readonly reason: StacksUnavailable["reason"]
  readonly host: string | null
}): ReactElement => {
  switch (reason) {
    case "not_configured":
      return (
        <StateCard eyebrow="Not available" title="Stacks aren’t available on this hub." tone="neutral">
          Set <Setting>RELAY_STACKS_HOST</Setting> to the host that holds the AWS profiles.
        </StateCard>
      )
    case "other_host":
      return (
        <StateCard eyebrow="Not available" title={`Stacks are read on ${host ?? "another host"}.`} tone="neutral">
          Open the hub on that host to see them.
        </StateCard>
      )
    case "not_hub":
      return (
        <StateCard eyebrow="Not available" title={`${host ?? "This host"} isn’t the hub.`} tone="neutral">
          <Setting>RELAY_STACKS_HOST</Setting> names this host, but stacks are read by the hub only.
        </StateCard>
      )
    case "unavailable":
      return (
        <StateCard eyebrow="Couldn’t start" title={`Stacks couldn’t start on ${host ?? "this host"}.`} tone="critical">
          Check its AWS configuration and state root, then reload.
        </StateCard>
      )
  }
}

const ProblemPanel = ({ problem }: { readonly problem: Problem }): ReactElement => {
  switch (problem._tag) {
    case "Unavailable":
      return <UnavailableCard host={problem.host} reason={problem.reason} />
    case "SignIn":
      return (
        <StateCard eyebrow="Signed out" title="Your Hub session ended." tone="caution">
          Reload this page to sign in again.
        </StateCard>
      )
    case "NotFound":
      return (
        <StateCard eyebrow="Not found" title="This stack is no longer available." tone="neutral">
          Return to Stacks and read again. Nothing was changed.
        </StateCard>
      )
    case "Failed":
      return problem.reason === "authentication" ? (
        <StateCard eyebrow="Sign-in expired" title="AWS sign-in expired on the stacks host." tone="caution">
          Run <Setting>aws sso login</Setting> there, then reload.
        </StateCard>
      ) : (
        <StateCard eyebrow="Read failed" title="Stacks couldn’t be read." tone="critical">
          {`The read failed (${problem.reason}). Reload to try again; nothing was changed.`}
        </StateCard>
      )
  }
}

const Header = (): ReactElement => (
  <header className="stacks-heading">
    <h1>Stacks</h1>
    <p>Infrastructure state, read-only</p>
  </header>
)

/** Facts phase 2 brings (apply runs, drift, gates): shown as unknown, never as empty or healthy. */
const Unchecked = (): ReactElement => (
  <span className="stacks-unchecked" data-unchecked="">
    Not checked yet
  </span>
)

/** The latest published plan in a few words. */
const planWords = (plan: PlanState | null): string => {
  if (plan === null) return "Reading…"
  switch (plan._tag) {
    case "Ready": {
      const updates = plan.plan.rows.filter((row) => row.action === "update").length
      const age = plan.plan.source.ageDays === 0 ? "today" : `${plan.plan.source.ageDays} d ago`
      return `${updates === 0 ? "No changes" : `${updates} ${updates === 1 ? "update" : "updates"}`}, ${age}`
    }
    case "Loading":
      return "Reading…"
    case "NotPublished":
      return "Not published"
    case "NotPublishing":
      return "Not publishing"
    case "NotConnected":
      return "Not connected"
    case "Expired":
      return "Expired"
    case "Failed":
      return "Plan run failed"
    case "Unverified":
      return "Unverified"
    case "Unreachable":
      return "Unreachable"
    case "Refused":
      return "Refused"
  }
}

const utcTime = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC"
})

/** What the published plan changes, for the Activity status column. */
const planChange = (plan: PlanState | null): string => {
  if (plan?._tag !== "Ready") return planWords(plan)
  const updates = plan.plan.rows.filter((row) => row.action === "update").length
  return updates === 0 ? "No changes" : `${updates} ${updates === 1 ? "update" : "updates"}`
}

/** When the plan was published: "12:15 UTC, today". */
const planWhen = (plan: PlanState | null): string | null => {
  if (plan?._tag !== "Ready") return null
  const { ageDays, publishedAt } = plan.plan.source
  // publishedAt is an unvalidated string on the wire: a malformed one drops the time, not the page.
  const date = new Date(publishedAt)
  const time = Number.isNaN(date.getTime()) ? null : `${utcTime.format(date)} UTC`
  return [time, ageDays === 0 ? "today" : `${ageDays} d ago`].filter((part) => part !== null).join(", ")
}

const planOf = (result: Result.Result<StackPlanResult, StacksReadFailed> | null): PlanState | null =>
  result === null
    ? null
    : Result.isFailure(result)
      ? { _tag: "Unreachable" }
      : result.success._tag === "Ready"
        ? result.success.plan
        : { _tag: "NotConnected" }

const stackHref = (stack: StackSummary) => moduleHref(stacksModule, "stack", new URLSearchParams({ id: stack.id }))

interface AppGroup {
  readonly app: string
  readonly members: ReadonlyArray<StackSummary>
}

/** Stacks grouped by app, apps and stages in name order. */
const byApp = (stacks: ReadonlyArray<StackSummary>): ReadonlyArray<AppGroup> => {
  const groups = new Map<string, Array<StackSummary>>()
  for (const stack of stacks) groups.set(stack.app, [...(groups.get(stack.app) ?? []), stack])
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([app, members]): AppGroup => ({ app, members: [...members].sort((a, b) => a.stage.localeCompare(b.stage)) }))
}

const unreadable = (stacks: ReadonlyArray<StackSummary>): string | null => {
  const names = stacks.filter((stack) => stack.resourceCount === null).map((stack) => `${stack.app} ${stack.stage}`)
  if (names.length === 0) return null
  const subject =
    names.length === 1
      ? `${names[0]} couldn’t be read, so its resources read`
      : `${names.join(", ")} couldn’t be read, so their resources read`
  return `${subject} Unknown. The other stacks were read.`
}

const Fact = ({ children, label }: { readonly label: string; readonly children: ReactNode }): ReactElement => (
  <td data-label={label}>{children}</td>
)

const OverviewTable = ({
  active,
  reads,
  stacks
}: {
  readonly stacks: ReadonlyArray<StackSummary>
  readonly reads: StacksModuleReads
  readonly active: boolean
}): ReactElement => {
  const plans = usePlans(reads, stacks, active)
  return (
    <div className="stacks-table-frame">
      <table className="stacks-table">
        <thead>
          <tr>
            <th scope="col">Stack</th>
            <th scope="col">Resources</th>
            <th scope="col">Last plan</th>
            <th scope="col">Last apply</th>
            <th scope="col">Drift</th>
            <th scope="col">Gate</th>
          </tr>
        </thead>
        <tbody>
          {byApp(stacks).map(({ app, members }) => [
            <tr className="stacks-group" data-app={app} key={`app:${app}`}>
              <th colSpan={6} scope="colgroup">
                <span className="stacks-mono">{app}</span>
                {`, ${members.length} ${members.length === 1 ? "stack" : "stacks"}`}
              </th>
            </tr>,
            ...members.map((stack) => (
              <tr key={stack.id}>
                <th scope="row">
                  <a className="stacks-name" href={stackHref(stack)}>
                    {stack.stage}
                  </a>
                </th>
                <Fact label="Resources">
                  <span className={stack.resourceCount === null ? "stacks-muted" : "stacks-count"}>
                    {stack.resourceCount === null ? "Unknown" : stack.resourceCount}
                  </span>
                </Fact>
                <Fact label="Last plan">{planWords(plans.get(stack.id) ?? null)}</Fact>
                <Fact label="Last apply">
                  <Unchecked />
                </Fact>
                <Fact label="Drift">
                  <Unchecked />
                </Fact>
                <Fact label="Gate">
                  <Unchecked />
                </Fact>
              </tr>
            ))
          ])}
        </tbody>
      </table>
    </div>
  )
}

const OverviewPage = ({
  mount,
  reads
}: {
  readonly reads: StacksModuleReads
  readonly mount: ModulePageMount
}): ReactElement => {
  const settled = useRead(reads.overview, mount.active, 0)
  const body = ((): ReactElement => {
    if (settled === null) {
      return (
        <div className="stacks-stack" aria-busy="true">
          <p className="stacks-summary" role="status">
            Reading stacks…
          </p>
          {[0, 1, 2, 3].map((row) => (
            <Skeleton className="stacks-skeleton-row" key={row} />
          ))}
        </div>
      )
    }
    if (Result.isFailure(settled)) return <ProblemPanel problem={problemFromFailure(settled.failure)} />
    const result: StacksOverviewResult = settled.success
    if (result._tag === "Unavailable") {
      return <ProblemPanel problem={{ _tag: "Unavailable", reason: result.reason, host: result.host }} />
    }
    if (result._tag === "Failed") return <ProblemPanel problem={{ _tag: "Failed", reason: result.reason }} />
    const stacks = result.list.stacks
    if (stacks.length === 0) {
      return (
        <StateCard eyebrow="No stacks" title="No alchemy stacks found under this host’s projects." tone="neutral" />
      )
    }
    const apps = new Set(stacks.map((stack) => stack.app)).size
    const partial = unreadable(stacks)
    // Phase 1 knows one reason a stack needs attention: its state couldn't be read.
    const attention = stacks.filter((stack) => stack.resourceCount === null).length
    return (
      <div className="stacks-stack">
        <p className="stacks-summary">
          {`${stacks.length} ${stacks.length === 1 ? "stack" : "stacks"} in ${apps} ${apps === 1 ? "app" : "apps"}`}
          {attention === 0 ? "." : `, ${attention} ${attention === 1 ? "needs" : "need"} attention.`}
        </p>
        {partial === null ? null : <Notice tone="neutral">{partial}</Notice>}
        {result.list.issues.length === 0 ? null : (
          <Notice tone="caution">
            {`Some sources couldn’t be read (${[...new Set(result.list.issues.map((issue) => `${issue.source}: ${issue.reason}`))].join(", ")}). Stacks that could be read are listed.`}
          </Notice>
        )}
        <OverviewTable active={mount.active} reads={reads} stacks={stacks} />
      </div>
    )
  })()
  return (
    <div className="stacks-page">
      <Header />
      <div className="stacks-body">{body}</div>
    </div>
  )
}

const detailProblem = (settled: Result.Result<StackDetailResult, StacksReadFailed>): Problem | null => {
  if (Result.isFailure(settled)) return problemFromFailure(settled.failure)
  const result = settled.success
  switch (result._tag) {
    case "Ready":
      return null
    case "Failed":
      return { _tag: "Failed", reason: result.reason }
    case "Unavailable":
      return { _tag: "Unavailable", reason: result.reason, host: result.host }
  }
}

const Activity = ({ plan }: { readonly plan: PlanState | null }): ReactElement => {
  const when = planWhen(plan)
  return (
    <section className="stacks-activity" aria-label="Activity">
      <h3>Activity</h3>
      <dl>
        <div>
          <dt>Last apply</dt>
          <dd className="stacks-status">
            <Unchecked />
          </dd>
        </div>
        <div>
          <dt>Last plan</dt>
          <dd className="stacks-status">{planChange(plan)}</dd>
          {/* Commit hashes tell people nothing; the commit stays in the tooltip. */}
          {when === null || plan?._tag !== "Ready" ? null : (
            <dd className="stacks-when" title={`Commit ${plan.plan.source.head}`}>
              {when}
            </dd>
          )}
          {plan?._tag === "Ready" ? (
            <dd className="stacks-run">
              <a href={plan.plan.source.runHref} rel="noreferrer" target="_blank">
                Open run
                <Icon decorative name="chevron-right" size="small" />
              </a>
            </dd>
          ) : null}
        </div>
      </dl>
    </section>
  )
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
  const headingId = useId()
  const id = decodeStackId(search.get("id"))
  const stackId: StackId | null = id._tag === "Some" ? id.value : null
  const view = search.get("view")
  const tab: StackTab = isStackTab(view) ? view : "resources"
  const [planGeneration, setPlanGeneration] = useState(0)
  const stackRead = useMemo(() => (stackId === null ? null : reads.stack(stackId)), [reads, stackId])
  const planRead = useMemo(() => (stackId === null ? null : reads.plan(stackId)), [reads, stackId])
  const settled = useRead(stackRead, mount.active, 0)
  const plan = planOf(useRead(planRead, mount.active, planGeneration))
  const back = (
    <a className="stacks-back" data-back="" href={moduleHref(stacksModule, "overview")}>
      ← All stacks
    </a>
  )
  const body = ((): ReactElement => {
    if (stackId === null) return <ProblemPanel problem={{ _tag: "NotFound" }} />
    if (settled === null) {
      return (
        <div aria-busy="true">
          <p className="stacks-sr" role="status">
            Reading the stack
          </p>
          <Skeleton style={{ blockSize: "12rem", inlineSize: "100%" }} />
        </div>
      )
    }
    const problem = detailProblem(settled)
    if (problem !== null || Result.isFailure(settled) || settled.success._tag !== "Ready") {
      return <ProblemPanel problem={problem ?? { _tag: "NotFound" }} />
    }
    const stack = settled.success.detail.state
    const href = (next: StackTab) => moduleHref(stacksModule, "stack", new URLSearchParams({ id: stackId, view: next }))
    return (
      <>
        <div className="stacks-title">
          <h2 id={headingId}>{stack.stage}</h2>
          <p>
            <span>
              App <span className="stacks-mono">{stack.app}</span>
            </span>
            <span>{`${stack.resources.length} ${stack.resources.length === 1 ? "resource" : "resources"}`}</span>
          </p>
        </div>
        <Activity plan={plan} />
        {/* ac-detail is the container the reused parts' narrow layout queries. */}
        <div className="ac-detail">
          <Tabs
            aria-label="Stack state"
            className="ac-detail-tabs stacks-tabs"
            data-mobile-layout="single-row"
            size="large"
            items={stackTabs.map((value) => ({
              value,
              label: tabLabels[value],
              content:
                value === "resources" ? (
                  <StackResourcesView resourceHref={null} stack={stack} />
                ) : value === "state" ? (
                  <StackStateTree app={stack.app} resourceHref={null} resources={stack.resources} stage={stack.stage} />
                ) : value === "outputs" ? (
                  <StackOutputsView outputs={stack.outputs} />
                ) : (
                  <PlanView
                    onReadAgain={() => setPlanGeneration((count) => count + 1)}
                    state={plan ?? { _tag: "Loading" }}
                  />
                )
            }))}
            onValueChange={(next) => {
              if (isStackTab(next)) mount.navigate(href(next), "replace", null)
            }}
            value={tab}
          />
        </div>
      </>
    )
  })()
  return (
    <div className="stacks-page">
      <Header />
      <div className="stacks-body">
        {back}
        {body}
      </div>
    </div>
  )
}

/** Reads run only while their page is active in the shell. */
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
