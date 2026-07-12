import { useEffect, useState } from "react"
import type { WorkflowEvent } from "./control-center-foundation.js"

const namespace = "cc:ockto-demo:workspace-engineering:control-center:v2"

export type ReviewState = "not-requested" | "requested" | "reviewed"
export interface AgentCodeReview {
  readonly sandbox: string
  readonly status: "analyzing" | "approved" | "changes-requested" | "checking-out" | "completed"
}
export interface AgentThreadEntry {
  readonly action?: "checks" | "description" | "summary"
  readonly actor: "agent" | "human" | "system"
  readonly id: string
  readonly status?: "completed" | "pending"
  readonly text: string
  readonly time: string
}
export interface ControlCenterSettings {
  readonly inferClockify: boolean
  readonly inferIssueKeys: boolean
  readonly inferRevisionAncestry: boolean
  readonly investigateFailures: boolean
  readonly refreshInterval: "live" | "manual" | "quarter-hour"
  readonly retainEvidence: boolean
  readonly retryPipelines: boolean
  readonly writeJiraComments: boolean
}
export interface JiraIssueComment {
  readonly body: string
  readonly id: string
  readonly name: string
  readonly parentId?: string
  readonly time: string
}
export interface JiraIssueHistoryEvent {
  readonly actor: string
  readonly label: string
  readonly time: string
}
export interface JiraIssueState {
  readonly checkedCriteria?: ReadonlyArray<string>
  readonly comments?: ReadonlyArray<JiraIssueComment>
  readonly description?: string
  readonly history?: ReadonlyArray<JiraIssueHistoryEvent>
}

export const defaultControlCenterSettings: ControlCenterSettings = {
  inferClockify: true,
  inferIssueKeys: true,
  inferRevisionAncestry: true,
  investigateFailures: true,
  refreshInterval: "live",
  retainEvidence: true,
  retryPipelines: false,
  writeJiraComments: true
}

const readStoredUnknown = (key: string): unknown => {
  if (typeof window === "undefined") return undefined
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(`${namespace}:${key}`) ?? "")
    return parsed
  } catch {
    return undefined
  }
}

const isUnknownRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const isStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string")

const isWorkflowEvent = (value: unknown): value is WorkflowEvent =>
  isUnknownRecord(value)
  && (value.actor === "agent" || value.actor === "human" || value.actor === "system")
  && typeof value.label === "string"
  && (value.sequence === undefined || typeof value.sequence === "number")
  && typeof value.time === "string"

const readWorkflowActivity = (): ReadonlyArray<WorkflowEvent> => {
  const stored = readStoredUnknown("audit")
  return Array.isArray(stored) && stored.every(isWorkflowEvent) ? stored : []
}

const readBooleanRecord = (key: string): Readonly<Record<string, boolean>> => {
  const stored = readStoredUnknown(key)
  if (!isUnknownRecord(stored)) return {}
  return Object.entries(stored).reduce<Readonly<Record<string, boolean>>>(
    (decoded, [entryKey, value]) => typeof value === "boolean" ? { ...decoded, [entryKey]: value } : decoded,
    {}
  )
}

const readStringRecord = (key: string): Readonly<Record<string, string>> => {
  const stored = readStoredUnknown(key)
  if (!isUnknownRecord(stored)) return {}
  return Object.entries(stored).reduce<Readonly<Record<string, string>>>(
    (decoded, [entryKey, value]) => typeof value === "string" ? { ...decoded, [entryKey]: value } : decoded,
    {}
  )
}

const isReviewState = (value: unknown): value is ReviewState =>
  value === "not-requested" || value === "requested" || value === "reviewed"

const readReviewStates = (): Readonly<Record<string, ReviewState>> => {
  const stored = readStoredUnknown("reviews")
  if (!isUnknownRecord(stored)) return {}
  return Object.entries(stored).reduce<Readonly<Record<string, ReviewState>>>(
    (decoded, [entityId, value]) => isReviewState(value) ? { ...decoded, [entityId]: value } : decoded,
    {}
  )
}

const isControlCenterSettings = (value: unknown): value is ControlCenterSettings =>
  isUnknownRecord(value)
  && typeof value.inferClockify === "boolean"
  && typeof value.inferIssueKeys === "boolean"
  && typeof value.inferRevisionAncestry === "boolean"
  && typeof value.investigateFailures === "boolean"
  && (value.refreshInterval === "live" || value.refreshInterval === "manual" ||
    value.refreshInterval === "quarter-hour")
  && typeof value.retainEvidence === "boolean"
  && typeof value.retryPipelines === "boolean"
  && typeof value.writeJiraComments === "boolean"

const readSettings = (): ControlCenterSettings => {
  const stored = readStoredUnknown("settings")
  return isControlCenterSettings(stored) ? stored : defaultControlCenterSettings
}

const isAgentThreadEntry = (value: unknown): value is AgentThreadEntry => {
  return isUnknownRecord(value)
    && (value.actor === "agent" || value.actor === "human" || value.actor === "system")
    && typeof value.id === "string"
    && typeof value.text === "string"
    && typeof value.time === "string"
    && (value.action === undefined
      || value.action === "checks"
      || value.action === "description"
      || value.action === "summary")
    && (value.status === undefined || value.status === "completed" || value.status === "pending")
}

const readAgentThreads = (): Readonly<Record<string, ReadonlyArray<AgentThreadEntry>>> => {
  const stored = readStoredUnknown("agent-threads")
  if (!isUnknownRecord(stored)) return {}
  return Object.entries(stored).reduce<Readonly<Record<string, ReadonlyArray<AgentThreadEntry>>>>(
    (decoded, [release, entries]) => ({
      ...decoded,
      [release]: Array.isArray(entries) ? entries.filter(isAgentThreadEntry) : []
    }),
    {}
  )
}

const isAgentCodeReview = (value: unknown): value is AgentCodeReview =>
  isUnknownRecord(value)
  && typeof value.sandbox === "string"
  && (value.status === "checking-out" || value.status === "analyzing" || value.status === "completed"
    || value.status === "approved" || value.status === "changes-requested")

const readAgentCodeReviews = (): Readonly<Record<string, AgentCodeReview>> => {
  const stored = readStoredUnknown("agent-code-reviews")
  if (!isUnknownRecord(stored)) return {}
  return Object.entries(stored).reduce<Readonly<Record<string, AgentCodeReview>>>(
    (decoded, [entityId, review]) => isAgentCodeReview(review) ? { ...decoded, [entityId]: review } : decoded,
    {}
  )
}

const isJiraIssueComment = (value: unknown): value is JiraIssueComment => {
  return isUnknownRecord(value)
    && typeof value.body === "string"
    && typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.time === "string"
    && (value.parentId === undefined || typeof value.parentId === "string")
}

const isJiraIssueHistoryEvent = (value: unknown): value is JiraIssueHistoryEvent => {
  return isUnknownRecord(value)
    && typeof value.actor === "string"
    && typeof value.label === "string"
    && typeof value.time === "string"
}

const isJiraIssueCommentArray = (value: unknown): value is ReadonlyArray<JiraIssueComment> =>
  Array.isArray(value) && value.every(isJiraIssueComment)

const isJiraIssueHistory = (value: unknown): value is ReadonlyArray<JiraIssueHistoryEvent> =>
  Array.isArray(value) && value.every(isJiraIssueHistoryEvent)

const readJiraIssueStates = (): Readonly<Record<string, JiraIssueState>> => {
  const stored = readStoredUnknown("jira-issues")
  if (!isUnknownRecord(stored)) return {}
  return Object.entries(stored).reduce<Readonly<Record<string, JiraIssueState>>>((decoded, [entityId, issue]) => {
    if (!entityId.startsWith("jira:") || !isUnknownRecord(issue)) return decoded
    if (issue.description !== undefined && typeof issue.description !== "string") return decoded
    if (issue.checkedCriteria !== undefined && !isStringArray(issue.checkedCriteria)) return decoded
    if (issue.comments !== undefined && !isJiraIssueCommentArray(issue.comments)) return decoded
    if (issue.history !== undefined && !isJiraIssueHistory(issue.history)) return decoded
    const jiraIssue: JiraIssueState = {
      ...(typeof issue.description === "string" ? { description: issue.description } : {}),
      ...(isStringArray(issue.checkedCriteria) ? { checkedCriteria: issue.checkedCriteria } : {}),
      ...(isJiraIssueCommentArray(issue.comments) ? { comments: issue.comments } : {}),
      ...(isJiraIssueHistory(issue.history) ? { history: issue.history } : {})
    }
    return { ...decoded, [entityId]: jiraIssue }
  }, {})
}

export function useControlCenterState() {
  const [workflowActivity, setWorkflowActivity] = useState<ReadonlyArray<WorkflowEvent>>(readWorkflowActivity)
  const [entityActions, setEntityActions] = useState<Readonly<Record<string, boolean>>>(() =>
    readBooleanRecord("actions")
  )
  const [entityLinks, setEntityLinks] = useState<Readonly<Record<string, string>>>(() => readStringRecord("links"))
  const [reviewStates, setReviewStates] = useState<Readonly<Record<string, ReviewState>>>(() => readReviewStates())
  const [settings, setSettings] = useState<ControlCenterSettings>(readSettings)
  const [agentThreads, setAgentThreads] = useState<Readonly<Record<string, ReadonlyArray<AgentThreadEntry>>>>(() =>
    readAgentThreads()
  )
  const [agentCodeReviews, setAgentCodeReviews] = useState<Readonly<Record<string, AgentCodeReview>>>(() =>
    readAgentCodeReviews()
  )
  const [jiraIssueStates, setJiraIssueStates] = useState<Readonly<Record<string, JiraIssueState>>>(() =>
    readJiraIssueStates()
  )

  useEffect(() => {
    window.localStorage.setItem(`${namespace}:audit`, JSON.stringify(workflowActivity))
  }, [workflowActivity])
  useEffect(() => {
    window.localStorage.setItem(`${namespace}:actions`, JSON.stringify(entityActions))
  }, [entityActions])
  useEffect(() => {
    window.localStorage.setItem(`${namespace}:links`, JSON.stringify(entityLinks))
  }, [entityLinks])
  useEffect(() => {
    window.localStorage.setItem(`${namespace}:reviews`, JSON.stringify(reviewStates))
  }, [reviewStates])
  useEffect(() => {
    window.localStorage.setItem(`${namespace}:settings`, JSON.stringify(settings))
  }, [settings])
  useEffect(() => {
    window.localStorage.setItem(`${namespace}:agent-threads`, JSON.stringify(agentThreads))
  }, [agentThreads])
  useEffect(() => {
    window.localStorage.setItem(`${namespace}:agent-code-reviews`, JSON.stringify(agentCodeReviews))
  }, [agentCodeReviews])
  useEffect(() => {
    window.localStorage.setItem(`${namespace}:jira-issues`, JSON.stringify(jiraIssueStates))
  }, [jiraIssueStates])
  useEffect(() => {
    const activeReviews = Object.entries(agentCodeReviews).filter(([, review]) =>
      review.status === "checking-out" || review.status === "analyzing"
    )
    if (activeReviews.length === 0) return
    const timeout = window.setTimeout(() => {
      setAgentCodeReviews((current) =>
        Object.fromEntries(
          Object.entries(current).map(([entityId, review]): readonly [string, AgentCodeReview] => [
            entityId,
            review.status === "checking-out"
              ? { ...review, status: "analyzing" }
              : review.status === "analyzing"
              ? { ...review, status: "completed" }
              : review
          ])
        )
      )
    }, activeReviews.some(([, review]) => review.status === "checking-out") ? 900 : 1500)
    return () => window.clearTimeout(timeout)
  }, [agentCodeReviews])

  const resetPersistentState = () => {
    window.localStorage.removeItem(`${namespace}:actions`)
    window.localStorage.removeItem(`${namespace}:audit`)
    window.localStorage.removeItem(`${namespace}:links`)
    window.localStorage.removeItem(`${namespace}:reviews`)
    window.localStorage.removeItem(`${namespace}:settings`)
    window.localStorage.removeItem(`${namespace}:agent-threads`)
    window.localStorage.removeItem(`${namespace}:agent-code-reviews`)
    window.localStorage.removeItem(`${namespace}:jira-issues`)
    setEntityActions({})
    setWorkflowActivity([])
    setEntityLinks({})
    setReviewStates({})
    setSettings(defaultControlCenterSettings)
    setAgentThreads({})
    setAgentCodeReviews({})
    setJiraIssueStates({})
  }

  return {
    agentThreads,
    agentCodeReviews,
    entityActions,
    entityLinks,
    jiraIssueStates,
    resetPersistentState,
    reviewStates,
    settings,
    setEntityActions,
    setAgentThreads,
    setAgentCodeReviews,
    setEntityLinks,
    setJiraIssueStates,
    setReviewStates,
    setSettings,
    setWorkflowActivity,
    workflowActivity
  }
}
