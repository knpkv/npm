import {
  Activity,
  Bot,
  Box,
  Check,
  ListTodo,
  Network,
  Plus,
  Search,
  Settings,
  Sparkles,
  TriangleAlert,
  X
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useSearchParams } from "react-router"
import { type ActionView, ActionViewPanel, type AgentScope, type ApprovalState } from "./control-center-action-panel.js"
import { ContextAgent } from "./control-center-context-agent.js"
import {
  AgentCodeReviewDialog,
  Brand,
  EntityActionDialog,
  type EntityLink,
  type EntityRecord,
  type Service,
  ServiceEntityPage,
  ServiceIcon
} from "./control-center-foundation.js"
import type { ReleasePortfolioEntry, TraceDetail, TraceId } from "./control-center-model.js"
import {
  paymentTicketDetails,
  releasePortfolio,
  releaseTickets,
  releaseWorksets,
  resolveEntity,
  traceDetails
} from "./control-center-model.js"
import { ReleaseBrief } from "./control-center-release-brief.js"
import { ReleasePeekDialog } from "./control-center-release-peek.js"
import { runReleaseViewTransition } from "./control-center-release-transition.js"
import { type ReviewState, useControlCenterState } from "./control-center-state.js"
import { ThemeToggle, useControlCenterTheme } from "./control-center-theme.js"
import { ReleaseGraph, TraceInspector } from "./control-center-trace.js"
import { PortfolioView } from "./control-center-variant-b-overviews.js"
import { ItemsView, type LinkedItem, SettingsView, TimelineView } from "./control-center-variant-b-views.js"
import { WipView } from "./control-center-wip-view.js"

interface FocusTarget {
  focus(): void
}

const activeFocusTarget = (): FocusTarget | null => {
  const activeElement = document.activeElement
  if (activeElement === null || !("focus" in activeElement)) return null
  const focus = activeElement.focus
  if (typeof focus !== "function") return null
  return { focus: () => Reflect.apply(focus, activeElement, []) }
}

const formatAuditTime = (sequence: number) => {
  const totalMinutes = 10 * 60 + 26 + sequence
  const hours = Math.floor(totalMinutes / 60) % 24
  const minutes = totalMinutes % 60
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`
}

function getCollectionItem<T>(items: ReadonlyArray<T>, index: number): T {
  const item = items[index] ?? items[0]
  if (item === undefined) throw new Error("Expected a non-empty control-center collection")
  return item
}

const auxiliaryTraceIds: ReadonlyArray<TraceId> = ["prOne", "prTwo", "release", "pipeline", "deploy", "failure", "time"]

export function VariantB() {
  const { theme, toggleTheme } = useControlCenterTheme()
  const [prototypeParams, setPrototypeParams] = useSearchParams()
  const initialView = prototypeParams.get("view")
  const initialEntityId = prototypeParams.get("entityId") ?? "pr:payments-api:284"
  const [screen, setScreen] = useState<"entity" | "overview" | "release" | "wip">(
    initialView === "entity"
      ? "entity"
      : initialView === "wip"
        ? "wip"
        : initialView && initialView !== "overview"
          ? "release"
          : "overview"
  )
  const [portfolioFilter, setPortfolioFilter] = useState<"all" | "attention" | "deploying" | "shipped">("all")
  const [peekRelease, setPeekRelease] = useState<number | null>(null)
  const [selectedTrace, setSelectedTrace] = useState<TraceId>("release")
  const [selectedTicket, setSelectedTicket] = useState(0)
  const [inspectorMode, setInspectorMode] = useState<"agent" | "object">("agent")
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [activeSection, setActiveSection] = useState(
    initialView === "items"
      ? "Items"
      : initialView === "timeline"
        ? "Timeline"
        : initialView === "settings"
          ? "Settings"
          : "Graph"
  )
  const [query, setQuery] = useState("")
  const [itemQuery, setItemQuery] = useState("")
  const [itemType, setItemType] = useState("all")
  const [itemStatus, setItemStatus] = useState("all")
  const [itemOwner, setItemOwner] = useState("all")
  const [relationFilter, setRelationFilter] = useState(false)
  const [statusFilter, setStatusFilter] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [actionView, setActionView] = useState<ActionView | null>(null)
  const [agentScope, setAgentScope] = useState<AgentScope>("release")
  const [deployStarted, setDeployStarted] = useState(false)
  const [watchedReleases, setWatchedReleases] = useState<ReadonlyArray<number>>([])
  const [buildNotifications, setBuildNotifications] = useState<ReadonlyArray<number>>([])
  const [acknowledgedReleases, setAcknowledgedReleases] = useState<ReadonlyArray<number>>([])
  const [queuedReleases, setQueuedReleases] = useState<ReadonlyArray<number>>([])
  const [linkedPr, setLinkedPr] = useState<string | null>(null)
  const [approvalState, setApprovalState] = useState<ApprovalState>("not-requested")
  const [fixesApplied, setFixesApplied] = useState(false)
  const {
    agentCodeReviews,
    agentThreads,
    entityActions,
    entityLinks,
    jiraIssueStates,
    resetPersistentState,
    reviewStates,
    setAgentCodeReviews,
    setAgentThreads,
    setEntityActions,
    setEntityLinks,
    setJiraIssueStates,
    setReviewStates,
    setSettings,
    setWorkflowActivity,
    settings,
    workflowActivity
  } = useControlCenterState()
  const wipReviewState = reviewStates["pr:billing-service:293"] ?? "not-requested"
  const [externalObject, setExternalObject] = useState<EntityRecord | null>(
    initialView === "entity" ? resolveEntity(initialEntityId) : null
  )
  const [pendingEntityAction, setPendingEntityAction] = useState<string | null>(null)
  const [agentReviewEntityId, setAgentReviewEntityId] = useState<string | null>(null)
  const [pendingLinkTarget, setPendingLinkTarget] = useState<string | null>(null)
  const [repairReleaseIndex, setRepairReleaseIndex] = useState(0)
  const [repairOriginReleaseIndex, setRepairOriginReleaseIndex] = useState<number | null>(null)
  const [repairedReleases, setRepairedReleases] = useState<ReadonlyArray<number>>([])
  const [connectionService, setConnectionService] = useState<Service | null>(null)
  const [timelineFilter, setTimelineFilter] = useState<"agent" | "all" | "human" | "system">("all")
  const [timelineRange, setTimelineRange] = useState<"today" | "two-days">("today")
  const [metric, setMetric] = useState("Trace coverage")
  const peekDialogRef = useRef<HTMLElement>(null)
  const peekCloseRef = useRef<HTMLButtonElement>(null)
  const peekPreviousFocusRef = useRef<FocusTarget | null>(null)
  const inspectorRef = useRef<HTMLElement>(null)
  const inspectorCloseRef = useRef<HTMLButtonElement>(null)
  const inspectorPreviousFocusRef = useRef<FocusTarget | null>(null)
  const activeActionViewRef = useRef<ActionView | null>(null)
  activeActionViewRef.current = actionView
  const addWorkflowActivity = (label: string) => {
    setWorkflowActivity((activity) => {
      const sequence = Math.max(0, ...activity.map((event) => event.sequence ?? 0)) + 1
      return [{ actor: "human", label, sequence, time: formatAuditTime(sequence) }, ...activity]
    })
  }
  const approvalRecorded = approvalState === "recorded" || entityActions["jira:OPS-412"] === true
  const pay119Linked = fixesApplied || linkedPr != null || entityActions["jira:PAY-119"] === true
  const externalObjectAudit = externalObject
    ? workflowActivity.find((event) => event.label.includes(externalObject.title))
    : undefined
  const pipelineRetryAudit = workflowActivity.find((event) => event.label.includes("Retry pipeline"))
  const selectedReleaseTicket = getCollectionItem(releaseTickets, selectedTicket)
  const inspectorEntityId =
    selectedTrace === "ticket"
      ? `jira:${selectedReleaseTicket.key}`
      : selectedTrace === "prOne"
        ? "pr:payments-api:284"
        : selectedTrace === "prTwo"
          ? "pr:payments-api:279"
          : selectedTrace === "time"
            ? "clockify:payments-rollup"
            : selectedTrace === "pipeline" || selectedTrace === "deploy" || selectedTrace === "failure"
              ? "pipeline:payments-api"
              : null
  const selectedBase: TraceDetail =
    selectedTrace === "ticket" ? getCollectionItem(paymentTicketDetails, selectedTicket) : traceDetails[selectedTrace]
  const selected: TraceDetail =
    approvalRecorded && selectedTrace === "ticket" && selectedTicket === 0
      ? {
          ...selectedBase,
          status: "Ready · approval recorded",
          properties: selectedBase.properties.map(([label, value]) =>
            label === "Status" ? [label, "Ready · approval recorded"] : [label, value]
          ),
          relations: [
            ["approved by", "Maya Chen · OPS-412-APR-9"],
            ["implemented by", "PR #284"],
            ["included in", "payments-api v2.18.0"]
          ],
          activity: ["Approval recorded in Jira at 10:23", ...selectedBase.activity]
        }
      : pay119Linked && selectedTrace === "ticket" && selectedTicket === 5
        ? {
            ...selectedBase,
            status: "In review · linked to PR #301",
            properties: selectedBase.properties.map(([label, value]) =>
              label === "Status" ? [label, "In review · linked to PR #301"] : [label, value]
            ),
            relations: [
              ["implemented by", "PR #301 · Open · review ready"],
              ["included in", "payments-api v2.18.0"],
              ["supported by", "Clockify · 1h 20m"]
            ],
            activity: ["PR #301 relationship applied at 10:24", ...selectedBase.activity]
          }
        : fixesApplied && selectedTrace === "release"
          ? {
              ...selectedBase,
              status: "Blocked · 1 test blocker",
              summary: "Trace is complete at 16/16. Integration run #1842 remains the only blocker.",
              properties: selectedBase.properties.map(([label, value]) =>
                label === "Changes" ? [label, "6 Jira · 3 PRs · 14 objects"] : [label, value]
              ),
              relations: [
                ["contains", "6 Jira items · 3 pull requests"],
                ["built by", "payments-production #1842"],
                ["documented by", "Confluence RUN-61"]
              ],
              activity: ["Trace fixes applied at 10:24", ...selectedBase.activity]
            }
          : selectedBase
  const inspectorRelationships: ReadonlyArray<EntityLink> = inspectorEntityId
    ? resolveEntity(inspectorEntityId).relationships
    : [
        { kind: "jira", label: "OPS-412 · Production access approval", relation: "CONTAINS", targetId: "jira:OPS-412" },
        {
          kind: "pipeline",
          label: "payments-production #1842",
          relation: "BUILT BY",
          targetId: "pipeline:payments-api"
        },
        {
          kind: "confluence",
          label: "RUN-61 · Payments production rollback",
          relation: "DOCUMENTED BY",
          targetId: "page:RUN-61"
        }
      ]
  const linkedItems: ReadonlyArray<LinkedItem> = [
    ...releaseTickets.map((item, index): LinkedItem => ({
      id: item.key,
      title: item.title,
      kind: "jira",
      type: "Jira issue",
      source: "Jira",
      status:
        (index === 0 && approvalRecorded) || (index === 5 && pay119Linked)
          ? "healthy"
          : item.tone === "done"
            ? "healthy"
            : item.tone === "missing"
              ? "missing"
              : "blocked",
      statusLabel:
        approvalRecorded && index === 0
          ? "Ready · approved"
          : pay119Linked && index === 5
            ? "In review · linked"
            : (item.status.split(" · ")[0] ?? item.status),
      owner: index % 2 === 0 ? "alex" : "maya",
      ownerLabel: index % 2 === 0 ? "Alex K." : "Maya Chen",
      updated: index < 2 ? "18 min" : "42 min",
      ticketIndex: index,
      traceId: "ticket"
    })),
    ...auxiliaryTraceIds.map((id, index): LinkedItem => {
      const item = traceDetails[id]
      const source = id.startsWith("pr")
        ? "CodeCommit"
        : id === "pipeline" || id === "deploy" || id === "failure"
          ? "CodePipeline"
          : id === "time"
            ? "Clockify"
            : "Control Center"
      return {
        id,
        title: item.title,
        kind: id.startsWith("pr")
          ? "pr"
          : id === "pipeline" || id === "deploy" || id === "failure"
            ? "pipeline"
            : id === "time"
              ? "clockify"
              : "release",
        type: item.type,
        source,
        status:
          entityActions["pipeline:payments-api"] && (id === "pipeline" || id === "failure")
            ? "healthy"
            : item.status.includes("Failed") || item.status.includes("Blocked")
              ? "blocked"
              : "healthy",
        statusLabel:
          entityActions["pipeline:payments-api"] && (id === "pipeline" || id === "failure")
            ? "Retry running"
            : (item.status.split(" · ")[0] ?? item.status),
        owner: index % 2 === 0 ? "alex" : "maya",
        ownerLabel: index % 2 === 0 ? "Alex K." : "Maya Chen",
        updated: index < 2 ? "18 min" : index < 5 ? "42 min" : "2 hr",
        traceId: id,
        ticketIndex: null
      }
    }),
    ...(linkedPr
      ? [
          {
            id: "prLinked",
            title: `PR ${linkedPr} · Refund telemetry`,
            kind: "pr",
            type: "CodeCommit pull request",
            source: "CodeCommit",
            status: "healthy",
            statusLabel: "Open · linked",
            owner: "maya",
            ownerLabel: "Maya Chen",
            updated: "now",
            traceId: "prOne",
            ticketIndex: null
          } satisfies LinkedItem
        ]
      : [])
  ]
  const filteredItems = linkedItems.filter(
    (item) =>
      (itemType === "all" || item.kind === itemType) &&
      (itemStatus === "all" || item.status === itemStatus) &&
      (itemOwner === "all" || item.owner === itemOwner) &&
      `${item.id} ${item.title} ${item.source}`.toLowerCase().includes(itemQuery.toLowerCase())
  )
  const matches = (text: string) => text.toLowerCase().includes(query.toLowerCase())
  const restoreRepairOrigin = () => {
    if (repairOriginReleaseIndex == null) return
    const release = releasePortfolio[repairOriginReleaseIndex]
    const next = new URLSearchParams(prototypeParams)
    next.set("view", "release")
    next.set("release", release?.service ?? "payments-api")
    next.delete("entityId")
    next.delete("backEntityId")
    next.delete("context")
    setPrototypeParams(next, { replace: true })
    setScreen("release")
    setPeekRelease(repairOriginReleaseIndex === 0 ? null : repairOriginReleaseIndex)
    setRepairOriginReleaseIndex(null)
  }
  const completeAction = (message: string) => {
    setActionView(null)
    setConnectionService(null)
    restoreRepairOrigin()
    setNotice(message)
  }
  const openReleasePeek = (releaseIndex: number, replace = false) => {
    if (releaseIndex < 0 || releaseIndex >= releasePortfolio.length) return
    const release = getCollectionItem(releasePortfolio, releaseIndex)
    setScreen("release")
    setExternalObject(null)
    setPeekRelease(releaseIndex)
    const next = new URLSearchParams(prototypeParams)
    next.set("view", "release")
    next.delete("entityId")
    next.delete("backEntityId")
    next.delete("context")
    next.delete("mode")
    next.set("release", release.service)
    setPrototypeParams(next, { replace })
  }
  const openReleaseFull = (releaseIndex: number, replace = false) => {
    if (releaseIndex < 0 || releaseIndex >= releasePortfolio.length) return
    const release = getCollectionItem(releasePortfolio, releaseIndex)
    runReleaseViewTransition(() => {
      setPeekRelease(null)
      setScreen("release")
      const next = new URLSearchParams(prototypeParams)
      next.set("view", "release")
      next.set("release", release.service)
      next.set("mode", "full")
      next.delete("entityId")
      next.delete("backEntityId")
      next.delete("context")
      setPrototypeParams(next, { replace })
    })
  }
  const closeReleasePeek = () => {
    runReleaseViewTransition(() => {
      setPeekRelease(null)
      const next = new URLSearchParams(prototypeParams)
      next.delete("view")
      next.delete("release")
      next.delete("mode")
      setScreen("overview")
      setPrototypeParams(next, { replace: true })
    }, "close")
  }
  const openRepair = (releaseIndex: number) => {
    const selectedRelease = prototypeParams.get("release")
    const openedFromRelease =
      screen === "release" &&
      (releaseIndex === 0
        ? selectedRelease === "payments-api" || selectedRelease == null
        : selectedRelease === releasePortfolio[releaseIndex]?.service || peekRelease === releaseIndex)
    setRepairOriginReleaseIndex(openedFromRelease ? releaseIndex : null)
    setPeekRelease(null)
    setRepairReleaseIndex(releaseIndex)
    setActionView("review")
  }
  const advanceApproval = () => {
    setApprovalState((current) => {
      const next = current === "not-requested" ? "requested" : current === "requested" ? "approved" : "recorded"
      addWorkflowActivity(
        next === "requested"
          ? "Approval requested from Maya"
          : next === "approved"
            ? "Approval APR-8842 received from Maya"
            : "Approval recorded in Jira as OPS-412-APR-9"
      )
      if (next === "recorded") {
        setEntityActions((actions) => ({ ...actions, "jira:OPS-412": true }))
      }
      return next
    })
  }
  const openMetric = (name: string, trace: TraceId) => {
    setMetric(name)
    setSelectedTrace(trace)
    setActionView("analytics")
  }
  const inspectTrace = (trace: TraceId) => {
    setSelectedTrace(trace)
    if (trace === "release") {
      setInspectorMode("object")
      setInspectorOpen(true)
      return
    }
    openExternalObject(
      trace === "ticket"
        ? `jira:${selectedReleaseTicket.key}`
        : trace === "prOne"
          ? "pr:payments-api:284"
          : trace === "prTwo"
            ? "pr:payments-api:279"
            : trace === "time"
              ? "clockify:payments-rollup"
              : "pipeline:payments-api"
    )
  }
  const openExternalObject = (entityId: string) => {
    setPeekRelease(null)
    setExternalObject(resolveEntity(entityId))
    setScreen("entity")
    const next = new URLSearchParams(prototypeParams)
    next.set("view", "entity")
    next.set("entityId", entityId)
    if (screen === "entity" && externalObject) next.set("backEntityId", externalObject.id)
    else next.delete("backEntityId")
    const context = next.get("context") ?? (screen === "wip" ? "wip" : activeSection === "Items" ? "items" : "release")
    next.set("context", context)
    if (context === "release") {
      const releaseService =
        prototypeParams.get("release") ??
        (peekRelease == null ? "payments-api" : releasePortfolio[peekRelease]?.service)
      if (releaseService) next.set("release", releaseService)
    } else next.delete("release")
    setPrototypeParams(next)
  }
  const riskRepairCount = Number(Boolean(entityLinks["jira:RISK-61"])) + Number(Boolean(entityActions["page:RUN-54"]))
  const riskLinkedPrId = entityLinks["jira:RISK-61"] ?? "pr:risk-engine:74"
  const riskLinkedPrNumber = riskLinkedPrId.split(":").at(-1) ?? "74"
  const portfolioReleases = releasePortfolio.map((release, index): ReleasePortfolioEntry =>
    index === 0 && entityActions["pipeline:payments-api"]
      ? { ...release, detail: "Retry #1843 running · new execution linked" }
      : index === 0 && fixesApplied
        ? { ...release, detail: "1 test blocker remains" }
        : index === 0 && (approvalRecorded || pay119Linked)
          ? {
              ...release,
              detail: `3 tests failed${approvalRecorded ? " · approval recorded" : " · approval missing"}${
                pay119Linked ? " · PR linked" : " · PR link missing"
              }`
            }
          : index === 5 && repairedReleases.includes(5)
            ? {
                ...release,
                state: "Can ship",
                tone: "ready",
                detail: "68 checks passed · trace complete",
                action: "Deploy",
                stages: ["Built", "Passed", "Ready"]
              }
            : index === 5 && riskRepairCount > 0
              ? { ...release, detail: `${2 - riskRepairCount} evidence gap remains` }
              : index === 3 && repairedReleases.includes(3)
                ? { ...release, detail: "8 of 12 jobs complete · trace complete" }
                : queuedReleases.includes(index)
                  ? {
                      ...release,
                      state: "Building",
                      tone: "building",
                      detail: "New execution queued after merge",
                      action: "Open",
                      stages: ["Merged", "Queued", "—"]
                    }
                  : index === 1 && deployStarted
                    ? {
                        ...release,
                        state: "Deploying",
                        tone: "moving",
                        detail: "Production rollout · 4%",
                        action: "Watch",
                        stages: ["Built", "Passed", "4%"]
                      }
                    : release
  )
  const remainingGaps = (index: number) =>
    index === 0
      ? Number(!approvalRecorded) + Number(!pay119Linked)
      : repairedReleases.includes(index)
        ? 0
        : index === 5
          ? 2 - riskRepairCount
          : getCollectionItem(releaseWorksets, index).gaps
  const hasAttention = (index: number) =>
    getCollectionItem(portfolioReleases, index).tone === "blocked" || remainingGaps(index) > 0
  const visibleReleases = portfolioReleases.filter(
    (release, index) =>
      portfolioFilter === "all" ||
      (portfolioFilter === "attention" && hasAttention(index)) ||
      (portfolioFilter === "deploying" && release.tone === "moving") ||
      (portfolioFilter === "shipped" && release.tone === "shipped")
  )
  const navigate = (view: "items" | "overview" | "release" | "settings" | "timeline" | "wip", replace = false) => {
    setConnectionService(null)
    setExternalObject(null)
    const next = new URLSearchParams(prototypeParams)
    next.delete("entityId")
    next.delete("backEntityId")
    next.delete("context")
    next.delete("service")
    next.delete("entity")
    next.delete("status")
    next.delete("release")
    if (view === "overview") next.delete("view")
    else next.set("view", view)
    if (view === "release") next.set("release", "payments-api")
    setScreen(view === "overview" ? "overview" : view === "wip" ? "wip" : "release")
    if (view === "release") setActiveSection("Graph")
    if (view === "items") setActiveSection("Items")
    if (view === "timeline") setActiveSection("Timeline")
    if (view === "settings") setActiveSection("Settings")
    setPrototypeParams(next, { replace })
  }
  useEffect(() => {
    const view = prototypeParams.get("view")
    setScreen(
      view === "entity" ? "entity" : view === "wip" ? "wip" : view && view !== "overview" ? "release" : "overview"
    )
    if (view === "entity") {
      const entityId = prototypeParams.get("entityId") ?? "pr:payments-api:284"
      setExternalObject((current) => (current?.id === entityId ? current : resolveEntity(entityId)))
    } else {
      setExternalObject(null)
      const releaseService = prototypeParams.get("release")
      if (view === "release" && releaseService && prototypeParams.get("mode") !== "full") {
        const releaseIndex = releasePortfolio.findIndex(({ service }) => service === releaseService)
        setPeekRelease(releaseIndex >= 0 ? releaseIndex : null)
      } else setPeekRelease(null)
    }
    if (view === "items") setActiveSection("Items")
    else if (view === "timeline") setActiveSection("Timeline")
    else if (view === "settings") setActiveSection("Settings")
    else if (view === "release") setActiveSection("Graph")
  }, [prototypeParams])
  useEffect(() => {
    if (entityActions["jira:OPS-412"]) setApprovalState("recorded")
    const pay119Link = entityLinks["jira:PAY-119"]
    if (pay119Link) {
      setLinkedPr(`#${pay119Link.split(":").at(-1)}`)
    }
    if (entityActions["trace:payments-api:fixes"]) setFixesApplied(true)
    const requestedReviews = Object.keys(entityActions).filter(
      (entityId) => entityActions[entityId] && entityId.startsWith("pr:billing-service:")
    )
    if (requestedReviews.length > 0) {
      setReviewStates((current) => {
        const missing = requestedReviews.filter((entityId) => current[entityId] == null)
        return missing.length === 0
          ? current
          : missing.reduce<Readonly<Record<string, ReviewState>>>(
              (reviews, entityId) => ({ ...reviews, [entityId]: "requested" }),
              current
            )
      })
    }
    if (entityActions["pipeline:checkout-web"]) setDeployStarted(true)
    const fullyMergedReleaseIndexes = releasePortfolio.flatMap(({ service }, releaseIndex) => {
      const requiredMerges = getCollectionItem(releaseWorksets, releaseIndex)
        .prs.map(([number]) => `pr:${service}:${number.replace("#", "")}`)
        .filter((entityId) => resolveEntity(entityId).action === "Merge pull request")
      return requiredMerges.length > 0 &&
        requiredMerges.every((entityId) => entityActions[entityId] === true) &&
        entityActions[`pipeline:${service}`] !== true
        ? [releaseIndex]
        : []
    })
    setQueuedReleases(fullyMergedReleaseIndexes)
  }, [entityActions, entityLinks])
  useEffect(() => {
    if (entityLinks["jira:RISK-61"] && entityActions["page:RUN-54"]) {
      setRepairedReleases((current) => [...new Set([...current, 5])])
    }
  }, [entityActions, entityLinks])
  useEffect(() => {
    if (peekRelease == null) return
    peekPreviousFocusRef.current = activeFocusTarget()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    peekCloseRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeReleasePeek()
      if (event.key !== "Tab") return
      const focusable = Array.from(
        peekDialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      )
      const first = focusable[0]
      const last = focusable.at(-1)
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener("keydown", onKeyDown)
      peekPreviousFocusRef.current?.focus()
    }
  }, [peekRelease])
  useEffect(() => {
    if (!inspectorOpen) return
    inspectorPreviousFocusRef.current = activeFocusTarget()
    inspectorCloseRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && activeActionViewRef.current == null) setInspectorOpen(false)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      inspectorPreviousFocusRef.current?.focus()
    }
  }, [inspectorOpen])
  const routeRelease = releasePortfolio.find(({ service }) => service === prototypeParams.get("release"))
  const routeReleaseIndex = releasePortfolio.findIndex(({ service }) => service === prototypeParams.get("release"))
  const fullRelease = screen === "release" && prototypeParams.get("mode") === "full" && routeReleaseIndex >= 0
  const entityContext = prototypeParams.get("context")
  const backEntityId = prototypeParams.get("backEntityId")
  const routePortfolioRelease = routeReleaseIndex >= 0 ? portfolioReleases[routeReleaseIndex] : undefined
  const peekPortfolioRelease = peekRelease == null ? undefined : portfolioReleases[peekRelease]
  const linkedExternalObjectId = externalObject ? entityLinks[externalObject.id] : undefined
  const displayedExternalObject: EntityRecord | null =
    externalObject && entityActions[externalObject.id]
      ? {
          ...externalObject,
          status: externalObject.completedStatus ?? externalObject.status,
          facts: externalObject.facts.map(([label, value]): readonly [string, string] =>
            label === "STATUS" || label === "STATE"
              ? [label, externalObject.completedStatus ?? externalObject.status]
              : [label, value]
          ),
          tabs: {
            ...externalObject.tabs,
            Activity: [
              `Human action recorded · ${externalObject.action}`,
              ...(externalObject.tabs.Activity ?? externalObject.activity)
            ]
          },
          activity: [
            `${externalObjectAudit?.time ?? "Recorded"} · ${externalObject.action} completed`,
            ...externalObject.activity
          ],
          relationships: linkedExternalObjectId
            ? [
                {
                  kind: "code",
                  label: resolveEntity(linkedExternalObjectId).title,
                  relation: "IMPLEMENTED BY",
                  targetId: linkedExternalObjectId
                },
                ...externalObject.relationships
              ]
            : externalObject.relationships
        }
      : externalObject

  const nonPaymentRelease =
    fullRelease && routeRelease?.service !== undefined && routeRelease.service !== "payments-api"
  const routeView = prototypeParams.get("view")
  const agentContext =
    screen === "entity"
      ? (externalObject?.facts.find(([label]) => label === "RELEASE")?.[1] ?? externalObject?.title ?? "this object")
      : screen === "wip"
        ? "OPS-428 active work"
        : routeView === "items"
          ? "Linked delivery items"
          : routeView === "timeline"
            ? "Delivery timeline"
            : routeView === "settings"
              ? "Workspace settings"
              : routeRelease
                ? `${routeRelease.service} ${routeRelease.version}`
                : "Release portfolio"
  const contextAgentScope: AgentScope =
    screen === "wip" || (screen === "entity" && prototypeParams.get("context") === "wip")
      ? "wip"
      : screen === "overview" || routeView === "items" || routeView === "timeline" || routeView === "settings"
        ? "portfolio"
        : "release"

  return (
    <div className={`cc-b cc-screen ${screen}${nonPaymentRelease ? " nonpayment-release" : ""}`} data-cc-theme={theme}>
      <header className="cc-b-header">
        <button className="cc-brand-home" aria-label="Open release overview" onClick={() => navigate("overview")}>
          <Brand />
        </button>
        <div className="cc-b-breadcrumb">
          <span>Delivery graph</span>
          <b>/</b>
          <strong>
            {screen === "overview"
              ? "Release overview"
              : screen === "wip"
                ? "OPS-428 active work"
                : screen === "entity"
                  ? (externalObject?.title ?? "Service object")
                  : routeRelease
                    ? `${routeRelease.service} v${routeRelease.version}`
                    : "payments-api v2.18.0"}
          </strong>
        </div>
        <nav className="cc-product-nav" aria-label="Control Center views">
          <button className={screen === "overview" ? "active" : ""} onClick={() => navigate("overview")}>
            Overview
          </button>
          <button
            className={
              (screen === "release" || (screen === "entity" && entityContext === "release")) &&
              activeSection === "Graph"
                ? "active"
                : ""
            }
            onClick={() => navigate("release")}
          >
            Release
          </button>
          <button
            className={screen === "wip" || (screen === "entity" && entityContext === "wip") ? "active" : ""}
            onClick={() => navigate("wip")}
          >
            Active work
          </button>
          <button
            className={activeSection === "Items" || (screen === "entity" && entityContext === "items") ? "active" : ""}
            onClick={() => navigate("items")}
          >
            Items
          </button>
          <button className={activeSection === "Timeline" ? "active" : ""} onClick={() => navigate("timeline")}>
            Timeline
          </button>
          <button className={activeSection === "Settings" ? "active" : ""} onClick={() => navigate("settings")}>
            Settings
          </button>
        </nav>
        <div className="cc-b-actions">
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
          <span>Synced 18 sec ago</span>
          <button onClick={() => setActionView("share")}>Share trace</button>
          <button
            className="cc-primary"
            onClick={() => {
              setAgentScope("release")
              setActionView("agent")
            }}
          >
            <Sparkles size={14} />
            Ask agent
          </button>
          <button className="cc-avatar" aria-label="Open account menu" onClick={() => setActionView("account")}>
            AK
          </button>
        </div>
      </header>
      <aside className="cc-b-rail">
        <button className={activeSection === "Graph" ? "active" : ""} onClick={() => setActiveSection("Graph")}>
          <Network size={18} />
          <span>Graph</span>
        </button>
        <button className={activeSection === "Items" ? "active" : ""} onClick={() => setActiveSection("Items")}>
          <ListTodo size={18} />
          <span>Items</span>
        </button>
        <button className={activeSection === "Timeline" ? "active" : ""} onClick={() => setActiveSection("Timeline")}>
          <Activity size={18} />
          <span>Timeline</span>
        </button>
        <div />
        <button className={activeSection === "Settings" ? "active" : ""} onClick={() => setActiveSection("Settings")}>
          <Settings size={18} />
          <span>Settings</span>
        </button>
      </aside>
      <aside className="cc-b-library">
        <div>
          <h2>Delivery traces</h2>
          <button aria-label="Create delivery trace" onClick={() => setActionView("newTrace")}>
            <Plus size={15} />
          </button>
        </div>
        <nav className="cc-library-nav">
          <button className={activeSection === "Graph" ? "active" : ""} onClick={() => setActiveSection("Graph")}>
            <Sparkles size={14} />
            Release
          </button>
          <button className={activeSection === "Items" ? "active" : ""} onClick={() => setActiveSection("Items")}>
            <ListTodo size={14} />
            Items
          </button>
          <button className={activeSection === "Timeline" ? "active" : ""} onClick={() => setActiveSection("Timeline")}>
            <Activity size={14} />
            Timeline
          </button>
          <button className={activeSection === "Settings" ? "active" : ""} onClick={() => setActiveSection("Settings")}>
            <Settings size={14} />
            Settings
          </button>
        </nav>
        <label>
          <Search size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ticket, PR, release…" />
        </label>
        <p>ACTIVE RELEASE</p>
        {matches("payments-api v2.18.0") && (
          <button className="cc-trace-list selected" onClick={() => setSelectedTrace("release")}>
            <span className="cc-release-icon">
              <Box size={15} />
            </span>
            <div>
              <b>payments-api v2.18.0</b>
              <span>{fixesApplied ? "14" : "13"} objects · 6 tickets · updated now</span>
            </div>
            <i className="cc-live-dot" />
          </button>
        )}
        {matches("checkout-web v4.7.1") && (
          <button className="cc-trace-list" onClick={() => setNotice("Loaded checkout-web v4.7.1 delivery trace")}>
            <span className="cc-release-icon">
              <Box size={15} />
            </span>
            <div>
              <b>checkout-web v4.7.1</b>
              <span>12 objects · deployed</span>
            </div>
            <Check size={13} />
          </button>
        )}
        <p>WORK IN PROGRESS</p>
        {matches("OPS-428 retry policy") && (
          <button className="cc-trace-list" onClick={() => navigate("wip")}>
            <ServiceIcon service="jira" />
            <div>
              <b>OPS-428 · Retry policy</b>
              <span>2 PRs · pipeline pending</span>
            </div>
          </button>
        )}
        {matches("PAY-119 refund flow") && (
          <button className="cc-trace-list" onClick={() => setNotice("PAY-119 has no linked pull request yet")}>
            <ServiceIcon service="jira" />
            <div>
              <b>PAY-119 · Refund flow</b>
              <span>No pull request linked</span>
            </div>
            <TriangleAlert size={13} />
          </button>
        )}
        {!["payments-api v2.18.0", "checkout-web v4.7.1", "OPS-428 retry policy", "PAY-119 refund flow"].some(
          matches
        ) && <div className="cc-empty-search">No delivery objects match “{query}”</div>}
        <div className="cc-trace-summary">
          <span className="cc-agent-avatar violet">
            <Bot size={15} />
          </span>
          <div>
            <b>Trace completeness</b>
            <span>Agent found 2 evidence gaps</span>
          </div>
          <button onClick={() => openRepair(0)}>Review</button>
        </div>
      </aside>

      <main className="cc-canvas">
        {nonPaymentRelease && routeRelease && (
          <section className="cc-release-route-shell" aria-hidden="true">
            <span>RELEASE · {routeRelease.version}</span>
            <h1>{routeRelease.service}</h1>
            <p>{routeRelease.detail}</p>
          </section>
        )}
        {screen === "entity" && externalObject && displayedExternalObject && (
          <ServiceEntityPage
            key={`${externalObject.service}:${externalObject.title}`}
            actionComplete={entityActions[externalObject.id] === true}
            {...(agentCodeReviews[externalObject.id] ? { agentReview: agentCodeReviews[externalObject.id] } : {})}
            backLabel={
              backEntityId
                ? `Back to ${resolveEntity(backEntityId).title}`
                : prototypeParams.get("context") === "wip"
                  ? "Back to active work"
                  : prototypeParams.get("context") === "items"
                    ? "Back to linked items"
                    : `Back to ${externalObject.facts.find(([label]) => label === "RELEASE")?.[1] ?? "release overview"}`
            }
            {...(jiraIssueStates[externalObject.id] ? { jiraIssueState: jiraIssueStates[externalObject.id] } : {})}
            object={displayedExternalObject}
            onBack={() => {
              const backEntityId = prototypeParams.get("backEntityId")
              if (backEntityId) {
                const next = new URLSearchParams(prototypeParams)
                next.set("entityId", backEntityId)
                next.delete("backEntityId")
                setExternalObject(resolveEntity(backEntityId))
                setPrototypeParams(next, { replace: true })
                return
              }
              const context = prototypeParams.get("context")
              if (context === "wip") {
                navigate("wip", true)
              } else if (context === "items") {
                navigate("items", true)
              } else {
                const releaseIndex = releasePortfolio.findIndex(
                  ({ service }) => service === prototypeParams.get("release")
                )
                if (prototypeParams.get("mode") === "full" && releaseIndex >= 0) {
                  openReleaseFull(releaseIndex, true)
                } else if (releaseIndex >= 0) openReleasePeek(releaseIndex, true)
                else navigate("overview", true)
              }
            }}
            onNotice={setNotice}
            onJiraIssueStateChange={(state) => {
              setJiraIssueStates((current) => ({ ...current, [externalObject.id]: state }))
            }}
            onOpenAgentReview={() => {
              const entityId = externalObject.id
              if (!agentCodeReviews[entityId]) {
                const prNumber = entityId.split(":").at(-1) ?? "pr"
                setAgentCodeReviews((current) => ({
                  ...current,
                  [entityId]: {
                    sandbox: `guardian/pr-${prNumber}-${entityId.length.toString(16)}a`,
                    status: "checking-out"
                  }
                }))
              }
              setAgentReviewEntityId(entityId)
            }}
            onAsk={() => {
              setAgentScope(prototypeParams.get("context") === "wip" ? "wip" : "release")
              setActionView("agent")
            }}
            onOpenRelated={(targetId) => {
              if (targetId === "release:overview") {
                navigate("overview")
              } else if (targetId?.startsWith("release:")) {
                const releaseService = targetId.slice("release:".length)
                if (releaseService === "overview") navigate("overview")
                else openReleasePeek(portfolioReleases.findIndex(({ service }) => service === releaseService))
              } else if (targetId) openExternalObject(targetId)
              else navigate("overview")
            }}
            onRequestAction={() => {
              setPendingLinkTarget(entityLinks[externalObject.id] ?? null)
              setPendingEntityAction(externalObject.id)
            }}
          />
        )}
        <PortfolioView
          entityLinks={entityLinks}
          filter={portfolioFilter}
          fixesApplied={fixesApplied}
          hasAttention={hasAttention}
          onAsk={() => {
            setAgentScope("portfolio")
            setActionView("agent")
          }}
          onOpenRelease={(service) => {
            openReleasePeek(portfolioReleases.findIndex((release) => release.service === service))
          }}
          releases={portfolioReleases}
          remainingGaps={remainingGaps}
          setFilter={setPortfolioFilter}
          visibleReleases={visibleReleases}
        />
        <WipView
          entityActions={entityActions}
          onAdvanceReview={() => {
            const next = wipReviewState === "not-requested" ? "requested" : "reviewed"
            setReviewStates((current) => ({ ...current, "pr:billing-service:293": next }))
            if (next === "requested") {
              setEntityActions((current) => ({ ...current, "pr:billing-service:293": true }))
            }
            setNotice(next === "requested" ? "Review request sent to Maya Chen" : "Maya Chen completed review")
          }}
          onGuide={() => {
            setAgentScope("wip")
            setActionView("agent")
          }}
          onOpenEntity={openExternalObject}
          reviewState={wipReviewState}
          reviewStates={reviewStates}
          workflowActivity={workflowActivity}
        />
        {fullRelease && routeReleaseIndex === 0 && (
          <ReleaseBrief
            agentEntries={agentThreads["payments-api:2.18.0"] ?? []}
            advanceApproval={advanceApproval}
            approvalRecorded={approvalRecorded}
            approvalState={approvalState}
            entityActions={entityActions}
            fixesApplied={fixesApplied}
            inspectTrace={inspectTrace}
            linkedPr={linkedPr}
            openExternalObject={openExternalObject}
            onAgentEntriesChange={(entries) =>
              setAgentThreads((current) => ({ ...current, "payments-api:2.18.0": entries }))
            }
            onBack={() => runReleaseViewTransition(() => navigate("overview"), "close")}
            pay119Linked={pay119Linked}
            pipelineRetryAudit={pipelineRetryAudit}
            setActionView={setActionView}
            setAgentScope={setAgentScope}
            setNotice={setNotice}
            setSelectedTicket={setSelectedTicket}
          />
        )}
        <ReleaseGraph
          fixesApplied={fixesApplied}
          inspectTrace={inspectTrace}
          openMetric={openMetric}
          relationFilter={relationFilter}
          selectedTicket={selectedTicket}
          selectedTrace={selectedTrace}
          setActionView={setActionView}
          setNotice={setNotice}
          setRelationFilter={setRelationFilter}
          setSelectedTicket={setSelectedTicket}
          setSelectedTrace={setSelectedTrace}
          setStatusFilter={setStatusFilter}
          statusFilter={statusFilter}
        />
        <TraceInspector
          fixesApplied={fixesApplied}
          inspectorCloseRef={inspectorCloseRef}
          inspectorMode={inspectorMode}
          inspectorOpen={inspectorOpen}
          inspectorRef={inspectorRef}
          inspectorRelationships={inspectorRelationships}
          navigate={navigate}
          openExternalObject={openExternalObject}
          selected={selected}
          selectedTicket={selectedTicket}
          selectedTrace={selectedTrace}
          setActionView={setActionView}
          setConnectionService={setConnectionService}
          setInspectorMode={setInspectorMode}
          setInspectorOpen={setInspectorOpen}
          setSelectedTicket={setSelectedTicket}
          inspectTrace={inspectTrace}
        />
        {activeSection === "Items" && (
          <ItemsView
            filteredItems={filteredItems}
            itemOwner={itemOwner}
            itemQuery={itemQuery}
            itemStatus={itemStatus}
            itemType={itemType}
            linkedItems={linkedItems}
            onAdd={() => setActionView("newTrace")}
            onOpen={(item) => {
              if (item.id === "prLinked") {
                openExternalObject("pr:payments-api:301")
                return
              }
              if (item.kind !== "release") {
                openExternalObject(
                  item.kind === "jira"
                    ? `jira:${item.id}`
                    : item.kind === "clockify"
                      ? "clockify:payments-rollup"
                      : item.kind === "pr"
                        ? item.traceId === "prTwo"
                          ? "pr:payments-api:279"
                          : "pr:payments-api:284"
                        : "pipeline:payments-api"
                )
                return
              }
              if (item.ticketIndex != null) setSelectedTicket(item.ticketIndex)
              setSelectedTrace(item.traceId)
              navigate("release")
              setInspectorMode("object")
              setInspectorOpen(true)
            }}
            setItemOwner={setItemOwner}
            setItemQuery={setItemQuery}
            setItemStatus={setItemStatus}
            setItemType={setItemType}
          />
        )}
        {activeSection === "Timeline" && (
          <TimelineView
            filter={timelineFilter}
            onExport={() => setActionView("export")}
            onOpenRepair={() => openRepair(0)}
            onSelectTrace={(trace) => {
              setSelectedTrace(trace)
              setActiveSection("Graph")
            }}
            range={timelineRange}
            setFilter={setTimelineFilter}
            setRange={setTimelineRange}
            workflowActivity={workflowActivity}
          />
        )}
        {activeSection === "Settings" && (
          <SettingsView
            onManagePermissions={() => setActionView("account")}
            onOpenSource={(service) => {
              setConnectionService(service)
              setActionView("source")
            }}
            onReset={() => {
              resetPersistentState()
              setPortfolioFilter("all")
              setPeekRelease(null)
              setSelectedTrace("release")
              setSelectedTicket(0)
              setInspectorMode("agent")
              setInspectorOpen(false)
              setQuery("")
              setItemQuery("")
              setItemType("all")
              setItemStatus("all")
              setItemOwner("all")
              setRelationFilter(false)
              setStatusFilter(false)
              setActionView(null)
              setAgentScope("release")
              setApprovalState("not-requested")
              setLinkedPr(null)
              setFixesApplied(false)
              setRepairedReleases([])
              setQueuedReleases([])
              setDeployStarted(false)
              setWatchedReleases([])
              setBuildNotifications([])
              setAcknowledgedReleases([])
              setPendingEntityAction(null)
              setPendingLinkTarget(null)
              setRepairReleaseIndex(0)
              setRepairOriginReleaseIndex(null)
              setConnectionService(null)
              setTimelineFilter("all")
              setTimelineRange("today")
              setMetric("Trace coverage")
              setNotice("Prototype data reset to the deterministic demo state")
            }}
            onSave={(nextSettings) => {
              setSettings(nextSettings)
              setNotice("Trace settings saved")
            }}
            settings={settings}
          />
        )}
        {fullRelease && routeReleaseIndex > 0 && routePortfolioRelease && (
          <ReleasePeekDialog
            acknowledgedReleases={acknowledgedReleases}
            agentEntries={agentThreads[routePortfolioRelease.service + ":" + routePortfolioRelease.version] ?? []}
            buildNotifications={buildNotifications}
            closeRef={peekCloseRef}
            deployStarted={deployStarted}
            dialogRef={peekDialogRef}
            onClose={() => runReleaseViewTransition(() => navigate("overview"), "close")}
            onAgentEntriesChange={(entries) => {
              const key = routePortfolioRelease.service + ":" + routePortfolioRelease.version
              setAgentThreads((current) => ({ ...current, [key]: entries }))
            }}
            onOpenEntity={openExternalObject}
            onOpenFull={() => openReleaseFull(routeReleaseIndex)}
            onPrimaryAction={(releaseIndex) => {
              const release = getCollectionItem(portfolioReleases, releaseIndex)
              if (release.tone === "ready") {
                setDeployStarted(true)
                addWorkflowActivity("checkout-web 4.7.1 rollout started")
                setNotice(`${release.service} deployment started at 4%`)
              } else if (release.tone === "moving") {
                setWatchedReleases((current) => [...new Set([...current, releaseIndex])])
                setNotice(`${release.service} rollout is now being watched`)
              } else if (release.tone === "building") {
                setBuildNotifications((current) => [...new Set([...current, releaseIndex])])
                setNotice(`${release.service} build notification enabled`)
              } else if (release.tone === "shipped") {
                setAcknowledgedReleases((current) => [...new Set([...current, releaseIndex])])
                setNotice(`${release.service} production evidence acknowledged`)
              } else if (release.tone === "warning") openRepair(releaseIndex)
            }}
            onRepair={openRepair}
            presentation="page"
            releaseIndex={routeReleaseIndex}
            releases={portfolioReleases}
            repairedReleases={repairedReleases}
            riskLinkedPrId={riskLinkedPrId}
            riskLinkedPrNumber={riskLinkedPrNumber}
            riskPrRepaired={Boolean(entityLinks["jira:RISK-61"])}
            riskRepairCount={riskRepairCount}
            riskRunbookRepaired={Boolean(entityActions["page:RUN-54"])}
            watchedReleases={watchedReleases}
          />
        )}
        {peekRelease != null && peekPortfolioRelease && (
          <ReleasePeekDialog
            acknowledgedReleases={acknowledgedReleases}
            agentEntries={agentThreads[peekPortfolioRelease.service + ":" + peekPortfolioRelease.version] ?? []}
            buildNotifications={buildNotifications}
            closeRef={peekCloseRef}
            deployStarted={deployStarted}
            dialogRef={peekDialogRef}
            onClose={closeReleasePeek}
            onAgentEntriesChange={(entries) => {
              const key = peekPortfolioRelease.service + ":" + peekPortfolioRelease.version
              setAgentThreads((current) => ({ ...current, [key]: entries }))
            }}
            onOpenEntity={openExternalObject}
            onOpenFull={() => openReleaseFull(peekRelease)}
            onPrimaryAction={(releaseIndex) => {
              const release = getCollectionItem(portfolioReleases, releaseIndex)
              if (release.tone === "ready") {
                setDeployStarted(true)
                addWorkflowActivity("checkout-web 4.7.1 rollout started")
                setNotice(`${release.service} deployment started at 4%`)
              } else if (release.tone === "moving") {
                setWatchedReleases((current) => [...new Set([...current, releaseIndex])])
                setNotice(`${release.service} rollout is now being watched`)
              } else if (release.tone === "building") {
                setBuildNotifications((current) => [...new Set([...current, releaseIndex])])
                setNotice(`${release.service} build notification enabled`)
              } else if (release.tone === "shipped") {
                setAcknowledgedReleases((current) => [...new Set([...current, releaseIndex])])
                setNotice(`${release.service} production evidence acknowledged`)
              } else if (release.tone === "warning") {
                openRepair(releaseIndex)
                return
              }
              closeReleasePeek()
            }}
            onRepair={openRepair}
            releaseIndex={peekRelease}
            releases={portfolioReleases}
            repairedReleases={repairedReleases}
            riskLinkedPrId={riskLinkedPrId}
            riskLinkedPrNumber={riskLinkedPrNumber}
            riskPrRepaired={Boolean(entityLinks["jira:RISK-61"])}
            riskRepairCount={riskRepairCount}
            riskRunbookRepaired={Boolean(entityActions["page:RUN-54"])}
            watchedReleases={watchedReleases}
          />
        )}
        {agentReviewEntityId && (
          <AgentCodeReviewDialog
            entity={resolveEntity(agentReviewEntityId)}
            onChange={(review) => {
              setAgentCodeReviews((current) => ({ ...current, [agentReviewEntityId]: review }))
            }}
            onClose={() => setAgentReviewEntityId(null)}
            {...(agentCodeReviews[agentReviewEntityId] ? { review: agentCodeReviews[agentReviewEntityId] } : {})}
          />
        )}
        <ContextAgent
          context={agentContext}
          onOpen={() => {
            setAgentScope(contextAgentScope)
            setActionView("agent")
          }}
        />
        {pendingEntityAction && (
          <EntityActionDialog
            entity={resolveEntity(pendingEntityAction)}
            selectedLink={pendingLinkTarget}
            onCancel={() => {
              setPendingEntityAction(null)
              setPendingLinkTarget(null)
            }}
            onSelectLink={setPendingLinkTarget}
            onConfirm={() => {
              const entity = resolveEntity(pendingEntityAction)
              setEntityActions((current) => ({ ...current, [entity.id]: true }))
              if (entity.action === "Link pull request" && pendingLinkTarget) {
                setEntityLinks((current) => ({ ...current, [entity.id]: pendingLinkTarget }))
              }
              if (entity.id === "jira:OPS-412") setApprovalState("recorded")
              if (entity.id === "jira:PAY-119" && pendingLinkTarget) {
                setLinkedPr(`#${pendingLinkTarget.split(":").at(-1)}`)
              }
              if (entity.id.startsWith("pr:billing-service:") && entity.action === "Request review") {
                setReviewStates((current) => ({ ...current, [entity.id]: "requested" }))
              }
              if (entity.id === "pipeline:checkout-web") {
                setQueuedReleases((current) => current.filter((index) => index !== 1))
                setDeployStarted(true)
              }
              if (entity.id === "pipeline:payments-api") {
                setNotice("Retry execution payments-production #1843 queued and linked")
              }
              addWorkflowActivity(
                `${entity.action} · ${entity.title}${
                  pendingLinkTarget ? ` → ${resolveEntity(pendingLinkTarget).title}` : ""
                } · permission verified · evidence recorded · result synchronized`
              )
              setPendingEntityAction(null)
              setPendingLinkTarget(null)
              setNotice(`${entity.action} completed · governed audit recorded`)
            }}
          />
        )}
        {notice && (
          <div className="cc-action-notice" role="status" aria-live="polite">
            <Check size={14} />
            <span>{notice}</span>
            <button data-quiet="true" aria-label="Dismiss notification" onClick={() => setNotice(null)}>
              <X size={13} />
            </button>
          </div>
        )}
        {actionView && (
          <ActionViewPanel
            agentScope={agentScope}
            approvalState={approvalState}
            connectionService={connectionService}
            fixesApplied={fixesApplied}
            linkedPr={linkedPr}
            portfolioContext={{
              active: portfolioReleases.filter(({ tone }) => tone !== "shipped").length,
              attention: portfolioReleases.filter((_, index) => hasAttention(index)).length
            }}
            repairApplied={repairedReleases.includes(repairReleaseIndex)}
            repairRelationshipApplied={
              repairReleaseIndex === 5
                ? Boolean(entityLinks["jira:RISK-61"])
                : repairedReleases.includes(repairReleaseIndex)
            }
            repairReleaseIndex={repairReleaseIndex}
            repairRunbookApplied={repairReleaseIndex === 5 && Boolean(entityActions["page:RUN-54"])}
            repairTargetPrNumber={riskLinkedPrNumber}
            view={actionView}
            metric={metric}
            selected={selected}
            onClose={() => {
              setActionView(null)
              setConnectionService(null)
              restoreRepairOrigin()
            }}
            onComplete={completeAction}
            onAdvanceApproval={advanceApproval}
            onApplyFixes={() => {
              setFixesApplied(true)
              setEntityActions((current) => ({
                ...current,
                "jira:PAY-119": true,
                "trace:payments-api:fixes": true
              }))
              if (linkedPr) {
                setEntityLinks((current) => ({
                  ...current,
                  "jira:PAY-119": `pr:payments-api:${linkedPr.replace("#", "")}`
                }))
              }
              addWorkflowActivity("Trace fixes applied · coverage 16/16")
            }}
            onApplyRepair={(selection) => {
              const repaired = getCollectionItem(portfolioReleases, repairReleaseIndex)
              const evidence =
                repairReleaseIndex === 5
                  ? [selection.relationship ? `PR #${riskLinkedPrNumber}` : null, selection.runbook ? "RUN-54" : null]
                      .filter(Boolean)
                      .join(" + ")
                  : "RUN-67"
              if (repairReleaseIndex === 5) {
                if (selection.relationship) {
                  setEntityLinks((current) => ({ ...current, "jira:RISK-61": riskLinkedPrId }))
                  setEntityActions((current) => ({ ...current, "jira:RISK-61": true }))
                }
                if (selection.runbook) {
                  setEntityActions((current) => ({ ...current, "page:RUN-54": true }))
                }
                const relationshipComplete = Boolean(entityLinks["jira:RISK-61"]) || selection.relationship
                const runbookComplete = Boolean(entityActions["page:RUN-54"]) || selection.runbook
                if (relationshipComplete && runbookComplete) {
                  setRepairedReleases((current) => [...new Set([...current, repairReleaseIndex])])
                }
              } else {
                setRepairedReleases((current) => [...new Set([...current, repairReleaseIndex])])
              }
              addWorkflowActivity(`${repaired.service} ${repaired.version} trace repaired · ${evidence} attached`)
            }}
            onRequestLink={() => setActionView("linkPr")}
            onStagePr={(pr) => {
              setLinkedPr(pr)
              setEntityLinks((current) => {
                const next = { ...current }
                if (pr) next["jira:PAY-119"] = `pr:payments-api:${pr.replace("#", "")}`
                else delete next["jira:PAY-119"]
                return next
              })
              addWorkflowActivity(pr ? `PR ${pr} staged for PAY-119` : "Staged PAY-119 relationship removed")
            }}
          />
        )}
      </main>
    </div>
  )
}
