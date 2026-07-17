// @vitest-environment happy-dom

import { PortalProvider } from "@knpkv/rly/foundations"
import * as Schema from "effect/Schema"
import { type ReactElement, act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import { SessionSummary, type SessionSummary as SessionSummaryType } from "../../src/api/session.js"
import type { BrowserSessionState } from "../../src/client/BrowserSession.js"
import { TimelineDetailSheet, timelineDetailLedger } from "../../src/client/timeline/TimelineDetailSheet.js"
import { canInspectTimelineDetails, timelineEventAgentPath } from "../../src/client/timeline/TimelinePage.js"
import {
  type TimelineDetailState,
  type TimelineDetailTransport,
  useTimelineDetail
} from "../../src/client/timeline/useTimelineDetail.js"
import { TimelineEventDetail, type TimelineEventDetail as TimelineEventDetailType } from "../../src/domain/timeline.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

const detail = Schema.decodeUnknownSync(TimelineEventDetail)({
  agentJob: { jobId: "agent-job-43" },
  event: {
    actor: { kind: "agent", label: "Relay reviewer" },
    eventKey: "action:01890f6f-6d6a-7cc0-98d2-000000000010",
    eventType: "review.completed",
    href: "/w/workspace/releases/release-43",
    occurredAt: "2026-07-17T18:43:12.000Z",
    service: "codepipeline",
    sourceKind: "action",
    title: "Relay approved the production candidate"
  },
  identifiers: {
    actionId: "action-43",
    actorId: null,
    entityId: "pipeline-execution-43",
    pluginConnectionId: "connection-codepipeline",
    relationshipId: null,
    releaseId: "release-43"
  }
})

const otherDetail = Schema.decodeUnknownSync(TimelineEventDetail)({
  ...Schema.encodeSync(TimelineEventDetail)(detail),
  event: {
    ...Schema.encodeSync(TimelineEventDetail)(detail).event,
    eventKey: "domain:01890f6f-6d6a-7cc0-98d2-000000000011",
    title: "Deployment reached production"
  }
})

const deferred = <Value,>() => {
  let resolveValue: ((value: Value) => void) | undefined
  const promise = new Promise<Value>((resolve) => {
    resolveValue = resolve
  })
  return {
    promise,
    resolve: (value: Value): void => {
      if (resolveValue === undefined) throw new Error("Deferred resolution unavailable")
      resolveValue(value)
    }
  }
}

const makeSession = (permission: SessionSummaryType["permission"]): SessionSummaryType =>
  Schema.decodeSync(SessionSummary)({
    absoluteExpiresAt: "2026-08-13T10:00:00.000Z",
    actor: { _tag: "human", personId: "01890f6f-6d6a-7cc0-98d2-000000000003" },
    createdAt: "2026-07-14T10:00:00.000Z",
    idleExpiresAt: "2026-07-14T22:00:00.000Z",
    lastSeenAt: "2026-07-14T10:01:00.000Z",
    permission,
    revokedAt: null,
    sessionId: "01890f6f-6d6a-7cc0-98d2-000000000004",
    workspaceId: "01890f6f-6d6a-7cc0-98d2-000000000001"
  })

let mountedRoot: Root | undefined
const observations: Array<TimelineDetailState> = []

afterEach(async () => {
  if (mountedRoot !== undefined) await act(async () => mountedRoot?.unmount())
  mountedRoot = undefined
  observations.length = 0
  document.body.replaceChildren()
})

const Harness = ({
  eventKey,
  onSessionExpired,
  transport
}: {
  readonly eventKey: string
  readonly onSessionExpired: (sessionKey: string) => void
  readonly transport: TimelineDetailTransport
}): ReactElement => {
  const controller = useTimelineDetail(eventKey, "session-a", onSessionExpired, transport)
  observations.push(controller.state)
  return <span>{controller.state._tag === "ready" ? controller.state.detail.event.title : controller.state._tag}</span>
}

describe("Timeline event details", () => {
  it("never exposes a completed response from the previous event selection", async () => {
    const requestA = deferred<TimelineEventDetailType>()
    const requestB = deferred<TimelineEventDetailType>()
    const requests = [requestA.promise, requestB.promise]
    const transport = {
      load: vi.fn(() => requests.shift() ?? Promise.reject(new Error("Unexpected Timeline detail request")))
    } satisfies TimelineDetailTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () =>
      mountedRoot?.render(<Harness eventKey={detail.event.eventKey} onSessionExpired={vi.fn()} transport={transport} />)
    )
    await act(async () =>
      mountedRoot?.render(
        <Harness eventKey={otherDetail.event.eventKey} onSessionExpired={vi.fn()} transport={transport} />
      )
    )
    await act(async () => requestA.resolve(detail))

    expect(host.textContent).toBe("loading")
    expect(observations.some((state) => state._tag === "ready" && state.eventKey === detail.event.eventKey)).toBe(false)

    await act(async () => requestB.resolve(otherDetail))
    expect(host.textContent).toBe("Deployment reached production")
  })

  it("invalidates the exact session after an unauthorized detail read", async () => {
    const onSessionExpired = vi.fn()
    const transport = {
      load: vi.fn(() => Promise.reject({ _tag: "UnauthorizedApiError" }))
    } satisfies TimelineDetailTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () =>
      mountedRoot?.render(
        <Harness eventKey={detail.event.eventKey} onSessionExpired={onSessionExpired} transport={transport} />
      )
    )
    await act(async () => Promise.resolve())

    expect(onSessionExpired).toHaveBeenCalledWith("session-a")
    expect(host.textContent).toBe("failed")
  })

  it("renders the selected event as a large identity with a compact non-secret ledger", async () => {
    const transport = { load: vi.fn(() => Promise.resolve(detail)) } satisfies TimelineDetailTransport
    const host = document.createElement("div")
    const portal = document.createElement("div")
    document.body.append(host, portal)
    mountedRoot = createRoot(host)

    await act(async () =>
      mountedRoot?.render(
        <MemoryRouter>
          <PortalProvider container={portal}>
            <TimelineDetailSheet
              agentHref="/w/workspace/agent?context=timeline"
              event={detail.event}
              onClose={vi.fn()}
              onSessionExpired={vi.fn()}
              sessionKey="session-a"
              transport={transport}
            />
          </PortalProvider>
        </MemoryRouter>
      )
    )
    await act(async () => Promise.resolve())

    const dialog = portal.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain("Relay approved the production candidate")
    expect(dialog?.textContent).toContain("CodePipeline")
    expect(dialog?.textContent).toContain("Agent job")
    expect(dialog?.textContent).toContain("agent-job-43")
    expect(dialog?.textContent).toContain("release-43")
    expect(dialog?.textContent).toContain("Ask Relay about this event")
    expect(dialog?.querySelector("#timeline-detail-title")?.textContent).toBe(detail.event.title)
  })

  it("reveals inspect controls only to workspace owners", () => {
    const owner = makeSession("workspace-owner")
    const approver = makeSession("workspace-approver")
    const ownerState = { _tag: "authenticated", session: owner } satisfies BrowserSessionState
    const degradedOwnerState = { _tag: "storage-unavailable", session: owner } satisfies BrowserSessionState
    const approverState = { _tag: "authenticated", session: approver } satisfies BrowserSessionState

    expect(canInspectTimelineDetails(ownerState)).toBe(true)
    expect(canInspectTimelineDetails(degradedOwnerState)).toBe(true)
    expect(canInspectTimelineDetails(approverState)).toBe(false)
    expect(canInspectTimelineDetails({ _tag: "anonymous" })).toBe(false)
  })

  it("preserves the selected event in the Relay context", () => {
    const href = timelineEventAgentPath(
      "/w/01890f6f-6d6a-7cc0-98d2-000000000001/timeline",
      "?actor=agent&from=2026-07-01",
      "",
      detail.event.eventKey
    )
    const from = new URL(href, "https://control-center.invalid").searchParams.get("from")

    expect(from).toBe(
      `/w/01890f6f-6d6a-7cc0-98d2-000000000001/timeline?actor=agent&from=2026-07-01&event=${encodeURIComponent(detail.event.eventKey)}`
    )
  })

  it("omits absent optional identifiers from the provenance ledger", () => {
    expect(timelineDetailLedger(detail)).toEqual([
      { label: "Event", value: detail.event.eventKey },
      { label: "Type", value: "review.completed" },
      { label: "Agent job", value: "agent-job-43" },
      { label: "Action", value: "action-43" },
      { label: "Connection", value: "connection-codepipeline" },
      { label: "Release", value: "release-43" },
      { label: "Entity", value: "pipeline-execution-43" }
    ])
  })
})
