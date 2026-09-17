import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { useEffect, useState } from "react"
import type { WorkflowEvent } from "./control-center-foundation.js"

const namespace = "cc:demo:workspace-engineering:control-center:v2"

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

const decodeStoredJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))

const readStoredUnknown = (key: string): Schema.Json | undefined => {
  try {
    return decodeStoredJson(window.localStorage.getItem(`${namespace}:${key}`) ?? "")
  } catch {
    return undefined
  }
}

const isUnknownRecord = <UnparsedInput>(
  value: UnparsedInput
): value is UnparsedInput & Readonly<Record<string, Schema.Json>> =>
  value !== null && Predicate.isObjectOrArray(value) && !Array.isArray(value)

const isStringArray = <UnparsedInput>(value: UnparsedInput): value is UnparsedInput & ReadonlyArray<string> =>
  Array.isArray(value) && value.every((entry) => Predicate.isString(entry))

const isWorkflowEvent = <UnparsedInput>(value: UnparsedInput): value is UnparsedInput & WorkflowEvent =>
  isUnknownRecord(value)
  && (value.actor === "agent" || value.actor === "human" || value.actor === "system")
  && Predicate.isString(value.label)
  && (value.sequence === undefined || Predicate.isNumber(value.sequence))
  && Predicate.isString(value.time)

const readWorkflowActivity = (): ReadonlyArray<WorkflowEvent> => {
  const stored = readStoredUnknown("audit")
  return Array.isArray(stored) && stored.every(isWorkflowEvent) ? stored : []
}

const readBooleanRecord = (key: string): Readonly<Record<string, boolean>> => {
  const stored = readStoredUnknown(key)
  if (!isUnknownRecord(stored)) return {}
  return Object.entries(stored).reduce<Readonly<Record<string, boolean>>>(
    (decoded, [entryKey, value]) => Predicate.isBoolean(value) ? { ...decoded, [entryKey]: value } : decoded,
    {}
  )
}

const readStringRecord = (key: string): Readonly<Record<string, string>> => {
  const stored = readStoredUnknown(key)
  if (!isUnknownRecord(stored)) return {}
  return Object.entries(stored).reduce<Readonly<Record<string, string>>>(
    (decoded, [entryKey, value]) => Predicate.isString(value) ? { ...decoded, [entryKey]: value } : decoded,
    {}
  )
}

const isReviewState = <UnparsedInput>(value: UnparsedInput): value is UnparsedInput & ReviewState =>
  value === "not-requested" || value === "requested" || value === "reviewed"

const readReviewStates = (): Readonly<Record<string, ReviewState>> => {
  const stored = readStoredUnknown("reviews")
  if (!isUnknownRecord(stored)) return {}
  return Object.entries(stored).reduce<Readonly<Record<string, ReviewState>>>(
    (decoded, [entityId, value]) => isReviewState(value) ? { ...decoded, [entityId]: value } : decoded,
    {}
  )
}

const isControlCenterSettings = <UnparsedInput>(value: UnparsedInput): value is UnparsedInput & ControlCenterSettings =>
  isUnknownRecord(value)
  && Predicate.isBoolean(value.inferClockify)
  && Predicate.isBoolean(value.inferIssueKeys)
  && Predicate.isBoolean(value.inferRevisionAncestry)
  && Predicate.isBoolean(value.investigateFailures)
  && (value.refreshInterval === "live" || value.refreshInterval === "manual" ||
    value.refreshInterval === "quarter-hour")
  && Predicate.isBoolean(value.retainEvidence)
  && Predicate.isBoolean(value.retryPipelines)
  && Predicate.isBoolean(value.writeJiraComments)

const readSettings = (): ControlCenterSettings => {
  const stored = readStoredUnknown("settings")
  return isControlCenterSettings(stored) ? stored : defaultControlCenterSettings
}

const isAgentThreadEntry = <UnparsedInput>(value: UnparsedInput): value is UnparsedInput & AgentThreadEntry => {
  return isUnknownRecord(value)
    && (value.actor === "agent" || value.actor === "human" || value.actor === "system")
    && Predicate.isString(value.id)
    && Predicate.isString(value.text)
    && Predicate.isString(value.time)
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

const isAgentCodeReview = <UnparsedInput>(value: UnparsedInput): value is UnparsedInput & AgentCodeReview =>
  isUnknownRecord(value)
  && Predicate.isString(value.sandbox)
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

const isJiraIssueComment = <UnparsedInput>(value: UnparsedInput): value is UnparsedInput & JiraIssueComment => {
  return isUnknownRecord(value)
    && Predicate.isString(value.body)
    && Predicate.isString(value.id)
    && Predicate.isString(value.name)
    && Predicate.isString(value.time)
    && (value.parentId === undefined || Predicate.isString(value.parentId))
}

const isJiraIssueHistoryEvent = <UnparsedInput>(
  value: UnparsedInput
): value is UnparsedInput & JiraIssueHistoryEvent => {
  return isUnknownRecord(value)
    && Predicate.isString(value.actor)
    && Predicate.isString(value.label)
    && Predicate.isString(value.time)
}

const isJiraIssueCommentArray = <UnparsedInput>(
  value: UnparsedInput
): value is UnparsedInput & ReadonlyArray<JiraIssueComment> => Array.isArray(value) && value.every(isJiraIssueComment)

const isJiraIssueHistory = <UnparsedInput>(
  value: UnparsedInput
): value is UnparsedInput & ReadonlyArray<JiraIssueHistoryEvent> =>
  Array.isArray(value) && value.every(isJiraIssueHistoryEvent)

const readJiraIssueStates = (): Readonly<Record<string, JiraIssueState>> => {
  const stored = readStoredUnknown("jira-issues")
  if (!isUnknownRecord(stored)) return {}
  return Object.entries(stored).reduce<Readonly<Record<string, JiraIssueState>>>((decoded, [entityId, issue]) => {
    if (!entityId.startsWith("jira:") || !isUnknownRecord(issue)) return decoded
    if (issue.description !== undefined && !Predicate.isString(issue.description)) return decoded
    if (issue.checkedCriteria !== undefined && !isStringArray(issue.checkedCriteria)) return decoded
    if (issue.comments !== undefined && !isJiraIssueCommentArray(issue.comments)) return decoded
    if (issue.history !== undefined && !isJiraIssueHistory(issue.history)) return decoded
    const jiraIssue: JiraIssueState = {
      ...((Predicate.isString(issue.description)) && { description: issue.description }),
      ...((isStringArray(issue.checkedCriteria)) && { checkedCriteria: issue.checkedCriteria }),
      ...((isJiraIssueCommentArray(issue.comments)) && { comments: issue.comments }),
      ...((isJiraIssueHistory(issue.history)) && { history: issue.history })
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
