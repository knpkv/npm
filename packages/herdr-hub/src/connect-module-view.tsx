import { Button } from "@knpkv/rly/primitives"
import { RelayChefMark } from "./internal/relay-chef-mark.js"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import type { ConnectAtoms } from "@knpkv/herdr-connect/surface"
import { connectAgentGroup, type ConnectAgent } from "@knpkv/herdr-connect/model"
import type { Effect } from "effect"
import { Option } from "effect"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { useMemo, type ReactElement } from "react"
import type { NotificationState } from "./approval-app-view.js"
import { BlockedConnectSurface } from "./blocked-connect-surface.js"
import {
  connectModule,
  fleetHubModule,
  moduleHref,
  type ModulePageMount,
  type ModuleViews,
  type NeedsYouResult
} from "./modules.js"
import { useNeedsYouReading, type TodayReadFailed } from "./today-module-view.js"
import { ShellIcon } from "./internal/shell-icon.js"
import { Setting, StateCard } from "./internal/state-card.js"

interface ConnectModuleContent {
  readonly atoms: ConnectAtoms
  readonly readApprovals: Effect.Effect<NeedsYouResult, TodayReadFailed>
  readonly now: number
  readonly notificationState: NotificationState
  /** Defaults true. A standalone computer has no Fleet: no approvals summary and no Fleet links. */
  readonly fleet?: boolean
  /** Defaults true. Only the notification hub serves push settings and stage heartbeats. */
  readonly push?: boolean
}

/** Both counts name their source. Incomplete or failed reads never claim that unknown work is clear. */
const ConnectModulePage = ({
  content,
  mount,
  search
}: {
  readonly content: ConnectModuleContent
  readonly mount: ModulePageMount
  readonly search: URLSearchParams
}): ReactElement => {
  const savedSearch = search.toString()
  const directoryLocation = useMemo(
    () => ({
      url: new URL(moduleHref(connectModule, "overview", new URLSearchParams(savedSearch)), window.location.href),
      navigate: (href: string, mode: "push" | "replace") => mount.navigate(href, mode, null),
      closeSelection: mount.closeSelection
    }),
    [savedSearch, mount.navigate, mount.closeSelection]
  )
  const directory = useAtomValue(content.atoms.agents)
  const refreshDirectory = useAtomRefresh(content.atoms.agents)
  const reading = Option.getOrNull(AsyncResult.value(directory))
  const fleet = content.fleet ?? true
  const approvals = useNeedsYouReading(content.readApprovals, mount.active && fleet)
  const failedHosts = reading?.failures.map((failure) => failure.host.toLowerCase()) ?? []
  const needing =
    reading?.agents.filter(
      (agent) =>
        connectAgentGroup(agent.state, {
          presentation: "home",
          offline: failedHosts.includes(agent.host.toLowerCase())
        }) === "needs-you"
    ).length ?? null
  const latest = reading?.agents.reduce<ConnectAgent | undefined>(
    (latest, agent) => (latest === undefined || agent.lastActivityAt > latest.lastActivityAt ? agent : latest),
    undefined
  )
  const waiting =
    approvals.reading?.result.items.filter((item) => item.expiresAt === null || item.expiresAt > content.now).length ??
    null
  const partial = approvals.reading?.result._tag === "Partial"
  const approvalsUnknown = waiting === null || (waiting === 0 && (partial || approvals.failed))
  const unreadApprovalHosts =
    approvals.reading?.result._tag === "Partial"
      ? [
          ...new Set(
            approvals.reading.result.sources.flatMap(({ issue }) =>
              issue.state === "hosts" ? issue.hosts.map(({ host }) => host) : []
            )
          )
        ]
      : []
  const partialApprovalCopy =
    unreadApprovalHosts.length === 0
      ? "Some sources couldn't be read completely"
      : `${new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(unreadApprovalHosts)} didn’t answer, so there may be more`
  const empty = reading !== null && reading.agents.length === 0 && reading.failures.length === 0
  const emptyStale = AsyncResult.isFailure(directory)
  const readingAt = AsyncResult.isSuccess(directory)
    ? directory.timestamp
    : AsyncResult.isFailure(directory) && Option.isSome(directory.previousSuccess)
      ? directory.previousSuccess.value.timestamp
      : null
  const emptyContent = !empty ? undefined : (
    <section className="connect-home-empty" aria-label="No agents">
      <RelayChefMark />
      <h2>
        {emptyStale
          ? "No agents in the previous reading."
          : fleet
            ? "No agents on any host yet"
            : "No agents on this computer yet"}
      </h2>
      {emptyStale ? null : (
        <p>{fleet ? "No host reported any agents." : "Herdr answered and has no agents running."}</p>
      )}
      {fleet ? (
        <ol>
          <li>Start an agent on a host. It appears here as soon as it starts.</li>
          <li>Or ask Relay to start one for a Work goal.</li>
        </ol>
      ) : (
        <ol>
          <li>
            Start an agent with <Setting>herdr</Setting>. It appears here as soon as it starts.
          </li>
          <li>Or ask Relay to start one.</li>
        </ol>
      )}
      <div className="connect-home-empty-actions">
        {fleet ? (
          <Button
            className="connect-home-tap"
            onClick={() => mount.navigate(moduleHref(fleetHubModule, "work"), "push")}
            size="compact"
            variant="primary"
          >
            Open Fleet, Work
          </Button>
        ) : null}
        {mount.openHostAccess === undefined ? null : (
          <Button className="connect-home-tap" onClick={mount.openHostAccess} size="compact" variant="secondary">
            Check hosts
          </Button>
        )}
      </div>
      {readingAt === null ? null : (
        <small>
          {emptyStale ? "Previous reading " : "Checked "}
          <time dateTime={new Date(readingAt).toISOString()}>
            {new Date(readingAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
          </time>
          {emptyStale ? ". Trying again." : null}
        </small>
      )}
    </section>
  )
  // A standalone computer whose Herdr is missing or stopped has nothing to list: say which, and how to fix it.
  const herdrReason =
    fleet || reading === null || reading.agents.length > 0
      ? undefined
      : reading.failures.find(
          (failure) => failure.reason === "herdr_not_installed" || failure.reason === "herdr_not_running"
        )?.reason
  const unavailableContent =
    herdrReason === undefined ? undefined : herdrReason === "herdr_not_installed" ? (
      <StateCard eyebrow="Not available" title="Herdr isn’t installed on this computer." tone="neutral">
        Install Herdr, then start an agent with <Setting>herdr</Setting>; it appears here.
      </StateCard>
    ) : (
      <StateCard
        action={
          <Button onClick={refreshDirectory} size="compact" variant="secondary">
            Retry
          </Button>
        }
        eyebrow="Not running"
        title="Herdr isn’t running on this computer."
        tone="caution"
      >
        Start Herdr, then retry.
      </StateCard>
    )
  const summary = !fleet ? undefined : empty && waiting === 0 && !partial && !approvals.failed ? undefined : (
    <section
      aria-label="Needs you and approvals"
      className={empty ? "connect-home-strip connect-home-strip-compact" : "connect-home-strip"}
    >
      {empty ? null : (
        <div data-previous-reading={AsyncResult.isFailure(directory) && reading !== null ? "" : undefined}>
          {AsyncResult.isFailure(directory) && reading !== null ? (
            <span aria-hidden="true" className="connect-home-count-context">
              Previous reading
            </span>
          ) : reading !== null && reading.failures.length > 0 ? (
            <span>At least</span>
          ) : null}
          <strong>{needing === null ? "Unknown" : String(needing)}</strong>
          <span>need you</span>
          {AsyncResult.isFailure(directory) && reading !== null ? (
            <span className="connect-home-count-announcement">, from the previous reading.</span>
          ) : null}
        </div>
      )}
      <a
        href={moduleHref(fleetHubModule, "approvals")}
        aria-label={approvalsUnknown ? "Approvals unknown, open Fleet Approvals" : undefined}
      >
        {approvalsUnknown ? null : (
          <span className="connect-home-approval-count">
            {approvals.failed && approvals.reading !== null ? (
              <span>Previous reading</span>
            ) : partial ? (
              <span>At least</span>
            ) : null}
            <strong>{String(waiting)}</strong>
          </span>
        )}
        <span className="connect-home-approvals-word">
          {approvalsUnknown ? "Approvals unknown" : waiting === 1 ? "approval waiting" : "approvals waiting"}
        </span>
        <ShellIcon name="next" />
        {!approvalsUnknown && (approvals.failed || partial) ? (
          <small>
            {approvals.failed
              ? approvals.reading === null
                ? "Couldn't read approvals"
                : "Couldn't refresh approvals"
              : partialApprovalCopy}
          </small>
        ) : null}
      </a>
      {empty ? null : (
        <p>
          {latest === undefined ? (
            "No activity reading yet"
          ) : (
            <>
              Last activity{" "}
              <time dateTime={new Date(latest.lastActivityAt).toISOString()}>
                {new Date(latest.lastActivityAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
              </time>
              , {latest.name}
              {latest.work.length === 0 ? null : `: ${latest.work}`}
            </>
          )}
        </p>
      )}
    </section>
  )
  return (
    <BlockedConnectSurface
      active={mount.active}
      atoms={content.atoms}
      directoryLocation={directoryLocation}
      notificationState={content.notificationState}
      push={content.push ?? true}
      embedded
      presentation={{
        _tag: "home",
        summary,
        empty: emptyContent,
        unavailable: unavailableContent
      }}
    />
  )
}

/** Promote the existing Connect owner; the summary subscribes to its atom without starting another read. */
export const makeConnectModuleViews = (content: ConnectModuleContent): ModuleViews<typeof connectModule> => ({
  descriptor: connectModule,
  navigationIcon: <ShellIcon name="connect" />,
  pages: { overview: (search, mount) => <ConnectModulePage content={content} mount={mount} search={search} /> }
})
