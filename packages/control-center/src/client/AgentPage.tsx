import { AgentThread, PeopleStrip, ReleaseRelay, type RlyAgentThreadMessage } from "@knpkv/rly/patterns"
import { Button, Field, StatePanel, Surface, Text } from "@knpkv/rly/primitives"
import * as DateTime from "effect/DateTime"
import * as Predicate from "effect/Predicate"
import { type FormEvent, type ReactElement, useEffect, useMemo, useRef, useState } from "react"
import { Link, Navigate, useLocation, useOutletContext, useParams, useSearchParams } from "react-router"

import type { PortfolioReleaseSummary } from "../api/portfolio.js"
import type { EntityId, EventCursor, ReleaseId, WorkspaceId } from "../domain/identifiers.js"
import { canonicalReleasePublicationTitle } from "../domain/releasePublication.js"
import { browserReadableSessionKey, useBrowserSession } from "./BrowserSession.js"
import { contextualReleaseAgentPath } from "./contextualAgentPath.js"
import { presentWorkspaceConfluencePage } from "./entities/presentWorkspaceConfluencePage.js"
import { useWorkspaceEntity, type WorkspaceEntityState } from "./entities/useWorkspaceEntity.js"
import { usePortfolioOverviewController } from "./portfolio/PortfolioOverview.js"
import type { PortfolioReleasePresentation } from "./portfolio/presentPortfolio.js"
import {
  decodeReleaseRouteId,
  decodeWorkspaceRouteId,
  releaseFullPath,
  releaseTransitionNames
} from "./releases/releaseRoutes.js"
import { decodeEntityRouteId, workspaceEntityTargetFromHref } from "./items/workspaceEntityRoutes.js"
import {
  readReleaseAgentThread,
  type StoredReleaseAgentThreadMessage,
  writeReleaseAgentThread
} from "./releases/releaseAgentThreadStorage.js"
import {
  type ConfluenceReleaseTemplate,
  type ConfluenceTemplateLoader,
  loadBrowserConfluenceTemplates
} from "./releases/confluenceTemplateTransport.js"
import type { WorkspaceReleaseOutletContext } from "./releases/WorkspaceReleaseLayout.js"
import {
  loadBrowserReleaseAgentPresets,
  runBrowserReleaseAgentTurn,
  submitBrowserReleasePublication
} from "./releases/releaseAgentTransport.js"
import styles from "./AgentPage.module.css"

/** Resolve a single unambiguous release while retaining the page that launched Relay. */
export const contextualSingleReleaseAgentPath = (
  workspaceId: WorkspaceId,
  releases: ReadonlyArray<PortfolioReleasePresentation>,
  originPath: string
): string | undefined => {
  const release = releases.length === 1 ? releases[0] : undefined
  return release === undefined ? undefined : contextualReleaseAgentPath(workspaceId, release.id, originPath)
}

export interface ReleaseAgentHistoryMessage {
  readonly content: string
  readonly role: "assistant" | "user"
}

export interface ReleaseAgentTurnInput {
  readonly history: ReadonlyArray<ReleaseAgentHistoryMessage>
  /** Same-origin page that launched Relay; omitted only for a direct release route. */
  readonly originPath?: string
  readonly prompt: string
  readonly provider: "claude" | "codex"
  readonly releaseId: ReleaseId
  readonly workspaceId: WorkspaceId
}

export interface ReleaseAgentTurnResult {
  readonly eventCursor: EventCursor
  readonly provider: "claude" | "codex"
  readonly release: PortfolioReleaseSummary
  readonly reply: string
}

export type ReleaseAgentTurn = (
  input: ReleaseAgentTurnInput,
  options: { readonly signal: AbortSignal }
) => Promise<ReleaseAgentTurnResult>

export type ReleaseAgentPresetLoader = (signal: AbortSignal) => Promise<ReadonlyArray<"claude" | "codex">>
export type { ConfluenceTemplateLoader } from "./releases/confluenceTemplateTransport.js"

export interface AgentPageProps {
  /** Application-owned local runtime boundary. Omit it to render an honest unavailable state. */
  readonly runTurn?: ReleaseAgentTurn
  /** Configured local presets. Omit only at deterministic/test boundaries. */
  readonly availableProviders?: ReadonlyArray<"claude" | "codex">
  /** Whether the connected route is still establishing a trustworthy provider catalog. */
  readonly providerCatalogPending?: boolean
  /** Workspace page catalog used only by the connected route's Confluence template picker. */
  readonly loadConfluenceTemplates?: ConfluenceTemplateLoader
}

interface AgentPageContext {
  readonly description: string
  readonly label: string
  readonly path: string | null
}

type LocalThreadMessage = StoredReleaseAgentThreadMessage

type TurnFailure =
  "blocked" | "conflict" | "failed" | "not-found" | "rate-limited" | "session-expired" | "timed-out" | "unavailable"

const DEFAULT_CONTEXT: AgentPageContext = {
  description: "The workspace-wide view of release readiness, people, source health, and agent work.",
  label: "Overview",
  path: "/"
}

const contexts: Readonly<Record<string, AgentPageContext>> = {
  "/": DEFAULT_CONTEXT,
  "/pair": {
    description: "The private browser-pairing flow. Credentials never become part of the agent context.",
    label: "Browser pairing",
    path: "/pair"
  },
  "/releases": {
    description: "Release relationships, blockers, collaborators, pull requests, and deployment evidence.",
    label: "Releases",
    path: "/releases"
  },
  "/services": {
    description: "Negotiated plugin health and the connections that provide delivery evidence.",
    label: "Services",
    path: "/services"
  }
}

const AGENT_CONTEXT_BASE = "https://control-center.invalid"
const SAME_ORIGIN_PATH = /^\/(?![\\/])[^\\]*$/u

const safeOriginPath = (candidate: string | null, fallback: string): string =>
  candidate !== null && SAME_ORIGIN_PATH.test(candidate) ? candidate : fallback

export const contextFor = (path: string | null): AgentPageContext => {
  if (path === null) return DEFAULT_CONTEXT
  const contextUrl = URL.parse(path, AGENT_CONTEXT_BASE)
  if (contextUrl === null || contextUrl.origin !== AGENT_CONTEXT_BASE) {
    return {
      description:
        "The calling page is not a recognized Control Center context. No fallback workspace or entity is substituted.",
      label: "Context unavailable",
      path: null
    }
  }
  const safePath = `${contextUrl.pathname}${contextUrl.search}${contextUrl.hash}`
  const knownContext = contexts[contextUrl.pathname]
  if (knownContext !== undefined) return { ...knownContext, path: safePath }
  const routeSegments = contextUrl.pathname.split("/")
  const workspaceId = decodeWorkspaceRouteId(routeSegments[2])
  const routeKind = routeSegments[3]
  const releaseId = decodeReleaseRouteId(routeSegments[4])
  const releaseSuffix = routeSegments[5]
  const isWorkspaceCollectionRoute = routeSegments[1] === "w" && routeSegments[4] === undefined
  const isReleaseRoute =
    routeSegments[1] === "w" &&
    workspaceId !== null &&
    routeKind === "releases" &&
    releaseId !== null &&
    (releaseSuffix === undefined || releaseSuffix === "preview" || releaseSuffix === "agent")
  if (isWorkspaceCollectionRoute && workspaceId !== null && routeKind === "overview" && releaseId === null) {
    return {
      description: `Workspace ${workspaceId} release readiness, people, source health, and agent work.`,
      label: "Workspace overview",
      path: safePath
    }
  }
  if (isWorkspaceCollectionRoute && workspaceId !== null && routeKind === "items" && releaseId === null) {
    const selectedEntityId = decodeEntityRouteId(contextUrl.searchParams.get("object"))
    if (selectedEntityId !== null) {
      return {
        description: `Workspace item ${selectedEntityId} is selected in the normalized delivery view. Relay will keep this exact entity selection and the surrounding item filters in context.`,
        label: `Workspace item ${selectedEntityId.slice(-6)}`,
        path: safePath
      }
    }
    return {
      description: `Current normalized delivery items in workspace ${workspaceId}, including the exact active filters and selection.`,
      label: "Workspace items",
      path: safePath
    }
  }
  const exactEntityId =
    routeSegments[1] === "w" && workspaceId !== null && routeKind === "items" && releaseSuffix === undefined
      ? decodeEntityRouteId(routeSegments[4])
      : null
  if (exactEntityId !== null) {
    return {
      description: `Workspace item ${exactEntityId} is open in the normalized delivery view. Relay will keep this exact entity in context.`,
      label: `Workspace item ${exactEntityId.slice(-6)}`,
      path: safePath
    }
  }
  if (isWorkspaceCollectionRoute && workspaceId !== null && routeKind === "timeline" && releaseId === null) {
    const selectedEvent = contextUrl.searchParams.get("event")
    return {
      description:
        selectedEvent === null
          ? `Attributable delivery activity in workspace ${workspaceId}, including the exact actor and date filters.`
          : `Timeline event ${selectedEvent} in workspace ${workspaceId}, including the exact actor and date filters.`,
      label: "Workspace timeline",
      path: safePath
    }
  }
  const activeWorkRelease = contextUrl.searchParams.get("release")
  const hasValidActiveWorkRelease = activeWorkRelease === null || decodeReleaseRouteId(activeWorkRelease) !== null
  if (
    isWorkspaceCollectionRoute &&
    workspaceId !== null &&
    routeKind === "work" &&
    releaseId === null &&
    hasValidActiveWorkRelease
  ) {
    return {
      description: `Active release decisions in workspace ${workspaceId}, including the exact selected release and filters.`,
      label: "Active work",
      path: safePath
    }
  }
  if (isReleaseRoute) {
    return {
      description: `Release ${releaseId} in workspace ${workspaceId}. Relay will resolve current release facts on the server before answering.`,
      label: `Release ${releaseId.slice(-6)}`,
      path: safePath
    }
  }
  return {
    description:
      "The calling page is not a recognized Control Center context. No fallback workspace or entity is substituted.",
    label: "Context unavailable",
    path: null
  }
}

const timestamp = (): Pick<LocalThreadMessage, "dateTime" | "time"> => {
  const now = DateTime.nowUnsafe()
  return {
    dateTime: DateTime.formatIso(now),
    time: DateTime.formatLocal(now, { hour: "2-digit", minute: "2-digit" })
  }
}

const failureTag = (failure: unknown): string | null => {
  if (!Predicate.hasProperty(failure, "_tag") || typeof failure._tag !== "string") return null
  return failure._tag
}

const classifyTurnFailure = (failure: unknown): TurnFailure => {
  switch (failureTag(failure)) {
    case "UnauthorizedApiError":
      return "session-expired"
    case "ForbiddenApiError":
      return "blocked"
    case "NotFoundApiError":
    case "ApplicationResourceNotFound":
      return "not-found"
    case "ConflictApiError":
      return "conflict"
    case "ServiceUnavailableApiError":
    case "ApplicationServiceUnavailable":
      return "unavailable"
    case "RateLimitedApiError":
      return "rate-limited"
    case "RequestTimedOutApiError":
      return "timed-out"
    default:
      return "failed"
  }
}

const failurePanel = (failure: TurnFailure): ReactElement => {
  switch (failure) {
    case "session-expired":
      return (
        <StatePanel
          action={<Link to="/pair">Pair this browser</Link>}
          announce="assertive"
          description="Pair this browser again, then return to the release thread. Your local messages remain in this tab."
          title="Session expired"
          tone="caution"
        />
      )
    case "blocked":
      return (
        <StatePanel
          announce="assertive"
          description="This connection cannot run a release agent. Use an allowed Control Center address."
          title="Agent access blocked"
          tone="critical"
        />
      )
    case "not-found":
      return (
        <StatePanel
          announce="assertive"
          description="This release is no longer in the current workspace snapshot. Return to the release before asking again."
          title="Release not found"
          tone="caution"
        />
      )
    case "conflict":
      return (
        <StatePanel
          announce="assertive"
          description="The release publication state changed or its destination is ambiguous. Refresh the release context and use the explicit publication controls."
          title="Release publication needs attention"
          tone="caution"
        />
      )
    case "unavailable":
      return (
        <StatePanel
          announce="assertive"
          description="Start the configured local Codex or Claude runner, then ask again."
          title="Relay is unavailable"
          tone="caution"
        />
      )
    case "rate-limited":
      return (
        <StatePanel
          announce="assertive"
          description="Relay has reached its local turn budget. Wait a moment, then submit the message again."
          title="Too many agent turns"
          tone="caution"
        />
      )
    case "timed-out":
      return (
        <StatePanel
          announce="assertive"
          description="The local model exceeded this turn's deadline. Narrow the question, then submit it again."
          title="Relay took too long"
          tone="caution"
        />
      )
    case "failed":
      return (
        <StatePanel
          announce="assertive"
          description="The agent did not complete this turn. Your message is still here; ask again when the runtime is ready."
          title="Relay could not answer"
          tone="critical"
        />
      )
  }
}

const RUN_PRESETS: ReadonlyArray<{
  readonly description: string
  readonly label: string
  readonly provider: "claude" | "codex"
}> = [
  {
    description: "Fast, repository-aware release work with the configured Codex CLI.",
    label: "Run with Codex",
    provider: "codex"
  },
  {
    description: "Use the configured Claude CLI for a second agent perspective.",
    label: "Run with Claude",
    provider: "claude"
  }
]

const PROMPT_TEMPLATES: ReadonlyArray<{
  readonly label: string
  readonly prompt: string
}> = [
  { label: "Release blockers", prompt: "What blocks this release?" },
  { label: "Release summary", prompt: "Write a concise release summary." },
  { label: "Missing evidence", prompt: "Which evidence is still missing?" }
]

const MAXIMUM_HISTORY_MESSAGES = 12
const MAXIMUM_HISTORY_MESSAGE_LENGTH = 12_000
const MAXIMUM_HISTORY_CONTENT_LENGTH = 64_000
const HISTORY_TRUNCATION_MARKER = "\n[earlier content truncated]"

/** Keep browser-owned thread history inside the public agent-turn payload contract. */
export const boundedReleaseAgentHistory = (
  messages: ReadonlyArray<ReleaseAgentHistoryMessage>
): ReadonlyArray<ReleaseAgentHistoryMessage> => {
  const history: Array<ReleaseAgentHistoryMessage> = []
  let contentLength = 0
  for (const message of messages.slice(-MAXIMUM_HISTORY_MESSAGES).reverse()) {
    const content =
      message.content.length <= MAXIMUM_HISTORY_MESSAGE_LENGTH
        ? message.content
        : `${message.content.slice(0, MAXIMUM_HISTORY_MESSAGE_LENGTH - HISTORY_TRUNCATION_MARKER.length)}${HISTORY_TRUNCATION_MARKER}`
    if (contentLength + content.length > MAXIMUM_HISTORY_CONTENT_LENGTH) break
    history.unshift({ content, role: message.role })
    contentLength += content.length
  }
  return history
}

const humanActor = {
  kind: "human",
  person: { avatarFallback: "YO", id: "current-operator", name: "You", role: "Release operator" }
} satisfies RlyAgentThreadMessage["actor"]

const agentActor = {
  avatarFallback: "AI",
  id: "relay",
  kind: "agent",
  name: "Relay",
  role: "Release agent"
} satisfies RlyAgentThreadMessage["actor"]

const presentMessages = (messages: ReadonlyArray<LocalThreadMessage>): ReadonlyArray<RlyAgentThreadMessage> =>
  messages.map((message) => ({
    actor: message.role === "user" ? humanActor : agentActor,
    content: message.content,
    dateTime: message.dateTime,
    id: message.id,
    time: message.time,
    ...(message.context === undefined
      ? {}
      : {
          evidence: (
            <span>
              Answered from {message.context.serviceName} {message.context.version} · {message.context.relayCodename} ·
              snapshot {message.context.eventCursor}
            </span>
          )
        })
  }))

const nextThreadSequence = (messages: ReadonlyArray<LocalThreadMessage>): number =>
  messages.reduce((next, { id }) => {
    const sequence = Number(id.split("-")[1])
    return Number.isSafeInteger(sequence) && sequence >= next ? sequence + 1 : next
  }, 0)

const ReleaseAgentComposer = ({
  disabled,
  isRunning,
  onPromptChange,
  onSubmit,
  prompt,
  provider
}: {
  readonly disabled: boolean
  readonly isRunning: boolean
  readonly onPromptChange: (prompt: string) => void
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void
  readonly prompt: string
  readonly provider: "claude" | "codex"
}): ReactElement => (
  <form className={styles.composer} onSubmit={onSubmit}>
    <Field label="What do you need?">
      {(controlProps) => (
        <textarea
          {...controlProps}
          autoFocus
          disabled={disabled}
          maxLength={8_000}
          onChange={(event) => onPromptChange(event.currentTarget.value)}
          placeholder="Ask about blockers, people, checks, or release notes…"
          rows={4}
          value={prompt}
        />
      )}
    </Field>
    <Button
      disabled={disabled || prompt.trim().length === 0}
      loading={isRunning}
      size="principal"
      stretch
      type="submit"
      variant="primary"
    >
      {`Ask Relay with ${provider === "codex" ? "Codex" : "Claude"}`}
    </Button>
  </form>
)

interface ConfluencePageDraftTarget {
  readonly contentState: "empty" | "lazy" | "loaded"
  readonly entityId: EntityId
  readonly markdown: string
  readonly revision: string
  readonly title: string
}

type ConfluencePageDraftContext =
  | { readonly _tag: "none" }
  | { readonly _tag: "loading" }
  | { readonly _tag: "unavailable" }
  | { readonly _tag: "ready"; readonly target: ConfluencePageDraftTarget }

type ConfluenceTemplateState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "failed" }
  | { readonly _tag: "ready"; readonly templates: ReadonlyArray<ConfluenceReleaseTemplate> }

const pageAwareAgentPrompt = (request: string, page: ConfluencePageDraftTarget): string => {
  const prefix = [
    "Work on the exact synchronized Confluence page below.",
    `Page title: ${page.title}`,
    `Current revision: ${page.revision}`,
    page.contentState === "loaded"
      ? "Current safe-Markdown page body:"
      : "The current page body was not synchronized. Draft a complete replacement body.",
    page.contentState === "loaded" ? "" : "No current body is available.",
    "",
    "User request:"
  ].join("\n")
  const suffix = `\n\n${request}`
  const availableBodyCharacters = Math.max(0, 8_000 - prefix.length - suffix.length)
  const body = page.contentState === "loaded" ? page.markdown.slice(0, availableBodyCharacters) : ""
  return `${prefix}\n${body}${suffix}`
}

/** Adopt only an exact synchronized Confluence page that belongs to this release. */
export const confluencePageDraftTarget = (
  state: WorkspaceEntityState,
  releaseId: ReleaseId
): ConfluencePageDraftTarget | null => {
  if (state._tag !== "ready" && state._tag !== "stale") return null
  const { entity, source } = state.inspection
  const details = entity.projection.details
  if (source.providerId !== "confluence" || details._tag !== "page" || !entity.releaseIds.includes(releaseId))
    return null
  const page = presentWorkspaceConfluencePage(details, state.inspection)
  return {
    contentState: page.contentState,
    entityId: entity.projection.entityId,
    markdown: page.content ?? "",
    revision: page.revision,
    title: entity.projection.title
  }
}

const ReleaseAgentRoom = ({
  availableProviders,
  confluencePage,
  loadConfluenceTemplates,
  providerCatalogPending,
  release,
  runTurn,
  workspaceId
}: {
  readonly release: PortfolioReleasePresentation
  readonly runTurn: ReleaseAgentTurn | undefined
  readonly availableProviders: ReadonlyArray<"claude" | "codex"> | undefined
  readonly confluencePage: ConfluencePageDraftContext
  readonly loadConfluenceTemplates?: ConfluenceTemplateLoader
  readonly providerCatalogPending: boolean
  readonly workspaceId: WorkspaceId
}): ReactElement => {
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const callingContext = contextFor(searchParams.get("from"))
  const [prompt, setPrompt] = useState("")
  const [provider, setProvider] = useState<"claude" | "codex">("codex")
  const providerWasSelected = useRef(false)
  const [messages, setMessages] = useState<ReadonlyArray<LocalThreadMessage>>(() => readReleaseAgentThread(release.id))
  const [failure, setFailure] = useState<TurnFailure | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [announcement, setAnnouncement] = useState("")
  const exactPage = confluencePage._tag === "ready" ? confluencePage.target : null
  const publicationDefaultTitle = exactPage?.title ?? canonicalReleasePublicationTitle(release.version)
  const publicationDefaultMarkdown =
    exactPage?.markdown ??
    "Release " + release.version + " for " + release.serviceName + ". Published by Relay after human confirmation."
  const [publicationTitle, setPublicationTitle] = useState(publicationDefaultTitle)
  const [publicationMarkdown, setPublicationMarkdown] = useState(publicationDefaultMarkdown)
  const [publicationBusy, setPublicationBusy] = useState<"jira" | "confluence" | null>(null)
  const [templateState, setTemplateState] = useState<ConfluenceTemplateState>(
    loadConfluenceTemplates === undefined ? { _tag: "ready", templates: [] } : { _tag: "loading" }
  )
  const [templateEntityId, setTemplateEntityId] = useState<EntityId | null>(null)
  const nextMessage = useRef(nextThreadSequence(messages))
  const activeTurn = useRef<AbortController | null>(null)
  const publicationRef = useRef<HTMLElement | null>(null)
  const transitionNames = releaseTransitionNames(release.id)

  useEffect(
    () => () => {
      const currentTurn = activeTurn.current
      activeTurn.current = null
      currentTurn?.abort()
    },
    []
  )

  useEffect(() => {
    writeReleaseAgentThread(release.id, messages)
  }, [messages, release.id])

  useEffect(() => {
    setPublicationTitle(publicationDefaultTitle)
    setPublicationMarkdown(publicationDefaultMarkdown)
  }, [
    exactPage?.entityId,
    exactPage?.revision,
    publicationDefaultMarkdown,
    publicationDefaultTitle,
    release.releasePageAwareness?.state
  ])

  useEffect(() => {
    if (exactPage !== null) publicationRef.current?.scrollIntoView({ block: "start" })
  }, [exactPage?.entityId])

  useEffect(() => {
    if (loadConfluenceTemplates === undefined || exactPage !== null) return
    const abort = new AbortController()
    setTemplateState({ _tag: "loading" })
    loadConfluenceTemplates(abort.signal).then(
      (templates) => {
        if (abort.signal.aborted) return
        setTemplateState({ _tag: "ready", templates })
      },
      () => {
        if (!abort.signal.aborted) setTemplateState({ _tag: "failed" })
      }
    )
    return () => abort.abort()
  }, [exactPage?.entityId, loadConfluenceTemplates])

  const threadMessages = useMemo(() => presentMessages(messages), [messages])
  const lastProvider = [...messages].reverse().find((message) => message.provider !== undefined)?.provider
  const runtimeUnavailable = runTurn === undefined
  const selectedProviderUnavailable =
    providerCatalogPending || (availableProviders !== undefined && !availableProviders.includes(provider))
  const providerCatalogEmpty = availableProviders?.length === 0
  const pageAwareness = release.releasePageAwareness
  const selectedTemplate =
    templateState._tag === "ready"
      ? (templateState.templates.find(({ entityId }) => entityId === templateEntityId) ?? null)
      : null
  const confluenceCreateReady = pageAwareness?.state === "not-published"
  const confluenceUpdateReady = pageAwareness?.state === "stale" && pageAwareness.publicationActionId !== undefined
  const confluencePublicationReady =
    exactPage !== null || selectedTemplate !== null || confluenceCreateReady || confluenceUpdateReady
  const confluenceAwarenessUnknown = pageAwareness === undefined || pageAwareness.state === "unknown"
  const latestRelayAnswer = [...messages].reverse().find(({ role }) => role === "assistant")?.content

  useEffect(() => {
    if (availableProviders === undefined || (providerWasSelected.current && availableProviders.includes(provider)))
      return
    const fallback = availableProviders[0]
    if (fallback !== undefined) setProvider(fallback)
  }, [availableProviders, provider])

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const submittedPrompt = prompt.trim()
    if (submittedPrompt.length === 0 || runTurn === undefined || selectedProviderUnavailable || isRunning) return
    const history = boundedReleaseAgentHistory(messages)
    const humanMessage = {
      ...timestamp(),
      content: submittedPrompt,
      id: `turn-${nextMessage.current++}-human`,
      role: "user"
    } satisfies LocalThreadMessage
    const abortController = new AbortController()
    activeTurn.current?.abort()
    activeTurn.current = abortController
    setMessages((current) => [...current, humanMessage])
    setPrompt("")
    setFailure(null)
    setIsRunning(true)
    setAnnouncement("Relay is reading the release context.")

    const originPath = safeOriginPath(searchParams.get("from"), `${location.pathname}${location.hash}`)
    const modelPrompt =
      exactPage !== null
        ? pageAwareAgentPrompt(submittedPrompt, exactPage)
        : selectedTemplate === null
          ? submittedPrompt
          : pageAwareAgentPrompt(submittedPrompt, {
              contentState: "loaded",
              entityId: selectedTemplate.entityId,
              markdown: selectedTemplate.markdown,
              revision: selectedTemplate.revision,
              title: selectedTemplate.title
            })
    runTurn(
      { history, originPath, prompt: modelPrompt, provider, releaseId: release.id, workspaceId },
      { signal: abortController.signal }
    )
      .then(
        (result) => {
          if (abortController.signal.aborted) return
          const reply = result.reply.trim()
          if (reply.length === 0) {
            setFailure("failed")
            setAnnouncement("Relay returned an empty answer.")
            return
          }
          setMessages((current) => [
            ...current,
            {
              ...timestamp(),
              content: reply,
              context: {
                eventCursor: result.eventCursor,
                relayCodename: result.release.relay.codename,
                serviceName: result.release.serviceName,
                updatedAt: result.release.updatedAt,
                version: result.release.version
              },
              id: `turn-${nextMessage.current++}-agent`,
              provider: result.provider,
              role: "assistant"
            }
          ])
          setAnnouncement("Relay answered in this release thread.")
        },
        (cause: unknown) => {
          if (abortController.signal.aborted) return
          setFailure(classifyTurnFailure(cause))
          setAnnouncement("Relay could not complete this turn.")
        }
      )
      .finally(() => {
        if (activeTurn.current !== abortController) return
        activeTurn.current = null
        setIsRunning(false)
      })
  }

  const publish = (publicationProvider: "jira" | "confluence"): void => {
    if (publicationBusy !== null || publicationTitle.trim() === "" || publicationMarkdown.trim() === "") return
    if (publicationProvider === "confluence" && !confluencePublicationReady) return
    setPublicationBusy(publicationProvider)
    const updatingConfluence = publicationProvider === "confluence" && (exactPage !== null || confluenceUpdateReady)
    setAnnouncement(
      "Relay is " +
        (updatingConfluence ? "updating" : "creating") +
        " the " +
        publicationProvider +
        " release artifact."
    )
    submitBrowserReleasePublication({
      releaseId: release.id,
      provider: publicationProvider,
      title: publicationTitle.trim(),
      markdown: publicationMarkdown.trim(),
      ...(updatingConfluence && exactPage === null && pageAwareness?.publicationActionId !== undefined
        ? { publicationActionId: pageAwareness.publicationActionId }
        : {}),
      ...(publicationProvider === "confluence" && exactPage !== null ? { targetEntityId: exactPage.entityId } : {}),
      ...(publicationProvider === "confluence" && exactPage === null && selectedTemplate !== null
        ? { templateEntityId: selectedTemplate.entityId }
        : {})
    })
      .then(
        (result) =>
          setAnnouncement(
            "Relay submitted a governed " +
              (updatingConfluence ? "Confluence page update" : publicationProvider + " publication") +
              " (" +
              result.state +
              ")."
          ),
        () => setAnnouncement("Relay could not publish the " + publicationProvider + " release artifact.")
      )
      .finally(() => setPublicationBusy(null))
  }

  return (
    <article className={styles.room} data-release-agent-id={release.id}>
      <Link className={styles.back} state={location.state} to={releaseFullPath(workspaceId, release.id)}>
        Back to release
      </Link>
      {callingContext.path !== null ? (
        <Link className={styles.back} to={callingContext.path}>
          Return to calling page
        </Link>
      ) : null}
      {callingContext.path !== null ? (
        <Text className={styles.eyebrow} tone="secondary" variant="label">
          {callingContext.label}
        </Text>
      ) : null}
      <header className={styles.hero}>
        <ReleaseRelay
          algorithm={release.relay.algorithm}
          codename={release.relay.codename}
          data-rly-release-transition-name={transitionNames.relay}
          data-rly-release-transition-part="relay"
          size="hero"
          style={{ viewTransitionName: transitionNames.relay }}
          symbolIndices={release.relay.symbolIndices}
        />
        <div className={styles.heroCopy}>
          <Text className={styles.eyebrow} tone="secondary" variant="label">
            {release.lifecycleLabel} · {release.version}
          </Text>
          <Text as="h1" id="agent-title" variant="verdict">
            Ask {release.relay.codename}.
          </Text>
          <Text tone="secondary" variant="body-large">
            Relay resolves the current release before every answer. This thread stays in this tab.
          </Text>
        </div>
      </header>

      <section aria-labelledby="agent-collaborators" className={styles.people}>
        <Text as="h2" id="agent-collaborators" variant="section-title">
          In this release
        </Text>
        {release.collaborators.length === 0 ? (
          <Text tone="secondary">No owner or approver is assigned yet.</Text>
        ) : (
          <PeopleStrip
            aria-label={`${release.serviceName} release collaborators`}
            expanded
            limit={release.collaborators.length}
            onExpandedChange={() => undefined}
            people={release.collaborators}
          />
        )}
      </section>

      <section aria-labelledby="agent-presets" className={styles.starters}>
        <Text as="h2" id="agent-presets" tone="secondary" variant="label">
          Agent preset
        </Text>
        <div aria-label="Agent presets" className={styles.presetList} role="radiogroup">
          {RUN_PRESETS.map((preset) => (
            <button
              aria-checked={provider === preset.provider}
              className={styles.preset}
              disabled={
                runtimeUnavailable ||
                isRunning ||
                providerCatalogPending ||
                (availableProviders !== undefined && !availableProviders.includes(preset.provider))
              }
              key={preset.provider}
              onClick={() => {
                providerWasSelected.current = true
                setProvider(preset.provider)
              }}
              role="radio"
              type="button"
            >
              <strong>{preset.label}</strong>
              <span>{preset.description}</span>
              {availableProviders !== undefined && !availableProviders.includes(preset.provider) ? (
                <small>Not configured</small>
              ) : null}
            </button>
          ))}
        </div>
        <Text as="h2" id="agent-starters" tone="secondary" variant="label">
          Prompt templates
        </Text>
        <div className={styles.suggestionList}>
          {[
            ...(exactPage === null
              ? []
              : [
                  {
                    label: "Draft this page",
                    prompt:
                      "Draft the complete updated Confluence page in Markdown for this release. Return only the page body, ready for owner review."
                  }
                ]),
            ...PROMPT_TEMPLATES
          ].map((template) => (
            <button
              className={styles.suggestion}
              disabled={runtimeUnavailable || selectedProviderUnavailable || isRunning}
              key={template.label}
              onClick={() => setPrompt(template.prompt)}
              type="button"
            >
              <strong>{template.label}</strong>
              <span>{template.prompt}</span>
            </button>
          ))}
        </div>
      </section>

      {runtimeUnavailable ? (
        <StatePanel
          description="Connect the server to a local Codex or Claude runner. Provider credentials and repository access stay server-side; this tab stores its bounded thread locally."
          title="Local agent not connected"
        />
      ) : providerCatalogPending ? null : providerCatalogEmpty ? (
        <StatePanel
          action={<Link to="/settings">Configure an agent</Link>}
          description="Enable a local Codex or Claude runner in Settings, then return here to draft or review this release."
          title="No agent is configured"
          tone="caution"
        />
      ) : selectedProviderUnavailable ? (
        <StatePanel
          description="Choose a configured Codex or Claude preset before starting this turn."
          title="Selected agent is not configured"
          tone="caution"
        />
      ) : null}
      {failure === null ? null : <div className={styles.failure}>{failurePanel(failure)}</div>}

      <AgentThread
        {...(announcement.length === 0 ? {} : { announcement })}
        className={styles.thread}
        composer={
          <ReleaseAgentComposer
            disabled={runtimeUnavailable || selectedProviderUnavailable}
            isRunning={isRunning}
            onPromptChange={setPrompt}
            onSubmit={onSubmit}
            prompt={prompt}
            provider={provider}
          />
        }
        context={
          <div className={styles.threadContext}>
            <strong>{release.serviceName}</strong>
            <span>{release.version}</span>
            <span>{release.relay.codename}</span>
            <span>Preset {provider}</span>
            {lastProvider === undefined ? null : <span>Last answer {lastProvider}</span>}
          </div>
        }
        emptyLabel="Ask one useful question. Relay will answer only for this release."
        heading="Release thread"
        messages={threadMessages}
      />
      <Surface
        as="section"
        aria-labelledby="relay-publication"
        className={`${styles.people} ${styles.publication}`}
        padding="spacious"
        ref={publicationRef}
        shape="grouped"
      >
        <Text as="h2" id="relay-publication" variant="section-title">
          {exactPage === null ? "Publish a release artifact" : "Edit this Confluence page"}
        </Text>
        <Text tone="secondary">
          {exactPage === null
            ? "These governed actions use the current release context and require your workspace-owner confirmation. Jira issue edits remain proposal-only."
            : `You are editing the synchronized page at revision ${exactPage.revision}. Type directly, or ask Relay for a draft and bring its latest answer into the editor. Publishing is an explicit, revision-guarded owner action.`}
        </Text>
        {exactPage === null ? (
          <div className={styles.templatePicker}>
            <div>
              <Text as="h3" variant="card-title">
                Start from a Confluence template
              </Text>
              <Text tone="secondary">
                Choose any synchronized Confluence page. Control Center creates a separate release-owned copy; the
                source page remains unchanged.
              </Text>
            </div>
            {templateState._tag === "loading" ? <Text tone="secondary">Loading Confluence templates…</Text> : null}
            {templateState._tag === "failed" ? (
              <Text tone="secondary">Templates could not be loaded. You can still write a new page from scratch.</Text>
            ) : null}
            {templateState._tag === "ready" && templateState.templates.length === 0 ? (
              <Text tone="secondary">
                No synchronized page body is available yet. Synchronize Confluence, then return here.
              </Text>
            ) : null}
            {templateState._tag === "ready" && templateState.templates.length > 0 ? (
              <Field label="Existing Confluence page">
                {(controlProps) => (
                  <select
                    {...controlProps}
                    onChange={(event) => {
                      const selected = templateState.templates.find(({ entityId }) => entityId === event.target.value)
                      if (selected === undefined) {
                        setTemplateEntityId(null)
                        return
                      }
                      setTemplateEntityId(selected.entityId)
                      setPublicationTitle(`${selected.title} — ${release.version}`)
                      setPublicationMarkdown(selected.markdown)
                      setAnnouncement("A copy of the template is now in the editor. The source page is unchanged.")
                    }}
                    value={templateEntityId ?? ""}
                  >
                    <option value="">Write a new page</option>
                    {templateState.templates.map((template) => (
                      <option key={template.entityId} value={template.entityId}>
                        {template.title} · revision {template.revision}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            ) : null}
            {selectedTemplate === null ? null : (
              <Button
                disabled={runtimeUnavailable || selectedProviderUnavailable || isRunning}
                onClick={() =>
                  setPrompt(
                    "Adapt the selected Confluence template for this release. Preserve its useful structure, replace placeholders with current release facts, and return only the complete Markdown body."
                  )
                }
                variant="secondary"
              >
                Ask Relay to adapt this copy
              </Button>
            )}
          </div>
        ) : null}
        {confluencePage._tag === "loading" ? (
          <Text tone="secondary">Loading the exact Confluence page that opened Relay…</Text>
        ) : null}
        {confluencePage._tag === "unavailable" ? (
          <Text tone="secondary">
            The calling item is not an editable Confluence page in this release. The generic release publication
            controls remain available.
          </Text>
        ) : null}
        {exactPage?.contentState === "lazy" ? (
          <Text tone="secondary">
            The existing page body was not synchronized. Start from a complete Relay draft or paste the complete page
            body before publishing; an empty replacement is blocked.
          </Text>
        ) : null}
        {pageAwareness?.state === "stale" ? (
          <Text tone="secondary">
            The release changed after the last successful Confluence publication. Relay suggests updating the page;
            publishing requires an explicit owner confirmation.
          </Text>
        ) : null}
        <Field label={exactPage === null ? "Title" : "Confluence page title"}>
          {(controlProps) => (
            <input
              {...controlProps}
              value={publicationTitle}
              onChange={(event) => setPublicationTitle(event.target.value)}
            />
          )}
        </Field>
        <Field label={exactPage === null ? "Release notes" : "Page body (Markdown)"}>
          {(controlProps) => (
            <textarea
              {...controlProps}
              rows={exactPage === null ? 6 : 10}
              value={publicationMarkdown}
              onChange={(event) => setPublicationMarkdown(event.target.value)}
            />
          )}
        </Field>
        {(exactPage !== null || selectedTemplate !== null) && latestRelayAnswer !== undefined ? (
          <Button
            disabled={publicationBusy !== null}
            onClick={() => {
              setPublicationMarkdown(latestRelayAnswer)
              setAnnouncement("The latest Relay answer is now in the page editor. Review it before publishing.")
            }}
            variant="secondary"
          >
            Use latest Relay answer
          </Button>
        ) : null}
        <div className={exactPage === null ? styles.presetList : styles.publicationAction}>
          {exactPage === null ? (
            <Button
              disabled={publicationBusy !== null}
              loading={publicationBusy === "jira"}
              onClick={() => publish("jira")}
            >
              Create Jira release version
            </Button>
          ) : null}
          <Button
            disabled={
              publicationBusy !== null ||
              !confluencePublicationReady ||
              confluencePage._tag === "loading" ||
              publicationTitle.trim() === "" ||
              publicationMarkdown.trim() === ""
            }
            loading={publicationBusy === "confluence"}
            onClick={() => publish("confluence")}
          >
            {exactPage !== null
              ? "Publish page update"
              : selectedTemplate !== null
                ? "Create template copy in Confluence"
                : pageAwareness?.state === "stale"
                  ? "Update Confluence release page"
                  : pageAwareness?.state === "current"
                    ? "Confluence release page is current"
                    : "Create Confluence release page"}
          </Button>
          {pageAwareness?.state === "current" ? (
            <Text tone="secondary">
              Relay will suggest an update after synchronized release changes make this page stale.
            </Text>
          ) : null}
          {pageAwareness?.state === "stale" && !confluenceUpdateReady ? (
            <Text tone="secondary">
              The existing page identity is unavailable, so Relay will not create a duplicate page.
            </Text>
          ) : null}
          {confluenceAwarenessUnknown ? (
            <Text tone="secondary">
              Confluence publication status is unavailable. Refresh the release context before publishing to avoid
              creating a duplicate page.
            </Text>
          ) : null}
        </div>
      </Surface>
    </article>
  )
}

type ReleaseAgentRoomProps = Omit<Parameters<typeof ReleaseAgentRoom>[0], "confluencePage">

const EntityContextReleaseAgentRoom = ({
  entityId,
  ...roomProps
}: ReleaseAgentRoomProps & { readonly entityId: EntityId }): ReactElement => {
  const browserSession = useBrowserSession()
  const sessionKey = browserReadableSessionKey(browserSession.state)
  const controller = useWorkspaceEntity(
    roomProps.workspaceId,
    entityId,
    `${roomProps.release.id}:${roomProps.release.version}`,
    sessionKey,
    browserSession.invalidateSession
  )
  const target = confluencePageDraftTarget(controller.state, roomProps.release.id)
  const confluencePage: ConfluencePageDraftContext =
    controller.state._tag === "idle" || controller.state._tag === "loading"
      ? { _tag: "loading" }
      : target === null
        ? { _tag: "unavailable" }
        : { _tag: "ready", target }
  return <ReleaseAgentRoom {...roomProps} confluencePage={confluencePage} />
}

const ContextualReleaseAgentRoom = (props: ReleaseAgentRoomProps): ReactElement => {
  const [searchParams] = useSearchParams()
  const target = workspaceEntityTargetFromHref(searchParams.get("from") ?? "")
  return target !== null && target.workspaceId === props.workspaceId ? (
    <EntityContextReleaseAgentRoom {...props} entityId={target.entityId} />
  ) : (
    <ReleaseAgentRoom {...props} confluencePage={{ _tag: "none" }} />
  )
}

const CanonicalAgentState = ({ context }: { readonly context: WorkspaceReleaseOutletContext }): ReactElement => {
  switch (context.controller.state._tag) {
    case "loading":
      return (
        <StatePanel
          description="Control Center is loading the exact release and its collaborators."
          title="Loading release context"
        />
      )
    case "session":
      return (
        <StatePanel
          action={
            context.controller.state.reason === "anonymous" ? <Link to="/pair">Pair this browser</Link> : undefined
          }
          description="Release context must be available before Relay can answer."
          title={
            context.controller.state.reason === "blocked" ? "Release access blocked" : "Release context unavailable"
          }
          tone={context.controller.state.reason === "blocked" ? "critical" : "caution"}
        />
      )
    case "failed":
      return (
        <StatePanel
          action={<Button onClick={context.controller.onRetry}>Try again</Button>}
          description="Control Center could not load the release. Check the server, then try again."
          title="Release context unavailable"
          tone="critical"
        />
      )
    case "ready":
      return <></>
  }
}

const LegacyAgentPage = (): ReactElement => {
  const [searchParams] = useSearchParams()
  const context = contextFor(searchParams.get("from"))
  return (
    <section aria-labelledby="agent-title" className={styles.legacy}>
      <header className={styles.legacyHeader}>
        <Text className={styles.eyebrow} tone="secondary" variant="label">
          Relay
        </Text>
        <Text as="h1" id="agent-title" variant="verdict">
          Ask in context.
        </Text>
        <Text tone="secondary" variant="body-large">
          Open Relay from a release to start an exact, release-owned thread.
        </Text>
      </header>
      <Surface as="section" className={styles.legacyContext} padding="spacious" shape="grouped" tone="secondary">
        <Text tone="secondary" variant="label">
          Current context
        </Text>
        <Text as="h2" variant="section-title">
          {context.label}
        </Text>
        <Text tone="secondary">{context.description}</Text>
        {context.path === null ? null : (
          <Link className={styles.back} to={context.path}>
            Return to {context.label}
          </Link>
        )}
      </Surface>
      <Surface as="section" className={styles.legacyContext} padding="spacious" shape="grouped">
        <Text tone="secondary" variant="label">
          Choose a release
        </Text>
        <Text as="h2" variant="section-title">
          Run Relay with an exact release context
        </Text>
        <Text tone="secondary">
          Relay never runs as an unscoped chatbot. Choose the release whose evidence, freshness, and permissions should
          bound the thread before sending a message.
        </Text>
        <Link className={styles.back} to="/releases">
          Choose a release to run Relay
        </Link>
      </Surface>
    </section>
  )
}

/** Choose an exact release while retaining the page that launched Relay. */
const ContextualAgentPage = ({ originPath }: { readonly originPath: string }): ReactElement => {
  const controller = usePortfolioOverviewController()
  const context = contextFor(originPath)
  switch (controller.state._tag) {
    case "session":
      return (
        <section aria-labelledby="agent-title" className={styles.state}>
          <Text as="h2" id="agent-title" variant="section-title">
            Release context stays private
          </Text>
          <StatePanel
            action={controller.state.reason === "anonymous" ? <Link to="/pair">Pair this browser</Link> : undefined}
            description="Pair this browser before Relay reads a workspace release."
            title="Pairing required"
            tone="caution"
          />
        </section>
      )
    case "loading":
      return (
        <section aria-labelledby="agent-title" className={styles.state}>
          <Text as="h2" id="agent-title" variant="section-title">
            Choosing a release
          </Text>
          <StatePanel description="Loading the releases for this page context." title="Choosing a release" />
        </section>
      )
    case "failed":
      return (
        <section aria-labelledby="agent-title" className={styles.state}>
          <Text as="h2" id="agent-title" variant="section-title">
            Release context unavailable
          </Text>
          <StatePanel
            action={<Button onClick={controller.onRetry}>Try again</Button>}
            description="Relay could not load the releases needed to preserve this page context."
            title="Release context unavailable"
            tone="critical"
          />
        </section>
      )
    case "ready": {
      const { portfolio } = controller.state
      const singleReleasePath = contextualSingleReleaseAgentPath(portfolio.workspaceId, portfolio.releases, originPath)
      if (singleReleasePath !== undefined) return <Navigate replace to={singleReleasePath} />
      return (
        <section aria-labelledby="agent-title" className={styles.legacy}>
          <header className={styles.legacyHeader}>
            <Text className={styles.eyebrow} tone="secondary" variant="label">
              Relay
            </Text>
            <Text as="h1" id="agent-title" variant="verdict">
              Choose a release.
            </Text>
            <Text tone="secondary" variant="body-large">
              Relay will keep the exact page context below and answer inside the release you choose.
            </Text>
          </header>
          <Surface as="section" className={styles.legacyContext} padding="spacious" shape="grouped" tone="secondary">
            <Text tone="secondary" variant="label">
              Calling page
            </Text>
            <Text as="h2" variant="section-title">
              {context.label}
            </Text>
            <Text tone="secondary">{context.description}</Text>
            {context.path !== null ? (
              <Link className={styles.back} to={context.path}>
                Return to calling page
              </Link>
            ) : null}
          </Surface>
          {portfolio.releases.length === 0 ? (
            <StatePanel
              action={<Link to="/services">Connect a service</Link>}
              description="Relay needs one synchronized release before it can start a scoped thread."
              title="No releases available"
            />
          ) : (
            <div aria-label="Releases available to Relay" className={styles.presetList}>
              {portfolio.releases.map((release) => (
                <Link
                  className={styles.preset}
                  key={release.id}
                  to={contextualReleaseAgentPath(portfolio.workspaceId, release.id, originPath)}
                >
                  <strong>{release.relay.codename}</strong>
                  <span>
                    {release.serviceName} · {release.version}
                  </span>
                  <small>{release.lifecycleLabel}</small>
                </Link>
              ))}
            </div>
          )}
        </section>
      )
    }
  }
}

/** Render an exact release-owned local agent thread, with a safe legacy context preview. */
export const AgentPage = ({
  availableProviders,
  loadConfluenceTemplates,
  providerCatalogPending = false,
  runTurn
}: AgentPageProps): ReactElement => {
  const context = useOutletContext<WorkspaceReleaseOutletContext | null>()
  const params = useParams()
  const workspaceId = decodeWorkspaceRouteId(params.workspaceId)
  const releaseId = decodeReleaseRouteId(params.releaseId)
  const isCanonicalRoute = params.workspaceId !== undefined || params.releaseId !== undefined

  if (!isCanonicalRoute) return <LegacyAgentPage />
  if (workspaceId === null || releaseId === null || context === null || context.workspaceId !== workspaceId) {
    return (
      <section className={styles.state}>
        <StatePanel
          action={workspaceId === null ? <Link to="/">Return to Control Center</Link> : undefined}
          description="This address does not identify a release in the current workspace."
          title="Release not found"
        />
      </section>
    )
  }
  if (context.controller.state._tag !== "ready") return <CanonicalAgentState context={context} />
  const release = context.controller.state.portfolio.releases.find((candidate) => candidate.id === releaseId)
  if (release === undefined) {
    return (
      <section className={styles.state}>
        <StatePanel
          action={
            <Link
              to={context.controller.state.portfolio.workspaceId === workspaceId ? `/w/${workspaceId}/overview` : "/"}
            >
              Return to workspace
            </Link>
          }
          description="This release does not exist in the current workspace snapshot."
          title="Release not found"
        />
      </section>
    )
  }
  return (
    <ContextualReleaseAgentRoom
      availableProviders={availableProviders}
      key={release.id}
      {...(loadConfluenceTemplates === undefined ? {} : { loadConfluenceTemplates })}
      providerCatalogPending={providerCatalogPending}
      release={release}
      runTurn={runTurn}
      workspaceId={workspaceId}
    />
  )
}

type ProviderCatalogState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "ready"; readonly providers: ReadonlyArray<"claude" | "codex"> }
  | { readonly _tag: "failed" }

/** Route entry wired to the authenticated Control Center release-agent API. */
export const ConnectedAgentPage = ({
  loadConfluenceTemplates = loadBrowserConfluenceTemplates,
  loadPresets = loadBrowserReleaseAgentPresets,
  runTurn = runBrowserReleaseAgentTurn
}: {
  readonly loadConfluenceTemplates?: ConfluenceTemplateLoader
  readonly loadPresets?: ReleaseAgentPresetLoader
  readonly runTurn?: ReleaseAgentTurn
} = {}): ReactElement => {
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const params = useParams()
  const [catalog, setCatalog] = useState<ProviderCatalogState>({ _tag: "loading" })
  const [catalogRequest, setCatalogRequest] = useState(0)
  useEffect(() => {
    const abort = new AbortController()
    setCatalog({ _tag: "loading" })
    loadPresets(abort.signal).then(
      (providers) => {
        if (!abort.signal.aborted) setCatalog({ _tag: "ready", providers })
      },
      () => {
        if (!abort.signal.aborted) setCatalog({ _tag: "failed" })
      }
    )
    return () => abort.abort()
  }, [catalogRequest, loadPresets])
  const availableProviders = catalog._tag === "ready" ? catalog.providers : undefined
  const isCanonicalRoute = params.workspaceId !== undefined || params.releaseId !== undefined
  const originPath = safeOriginPath(searchParams.get("from"), `${location.pathname}${location.hash}`)
  return (
    <>
      {catalog._tag === "failed" ? (
        <section className={styles.state}>
          <StatePanel
            action={<Button onClick={() => setCatalogRequest((request) => request + 1)}>Retry agent presets</Button>}
            description="Relay could not confirm the configured local runners. You can retry without leaving this release."
            title="Agent presets could not be refreshed"
            tone="caution"
          />
        </section>
      ) : null}
      {isCanonicalRoute ? (
        <AgentPage
          {...(availableProviders === undefined ? {} : { availableProviders })}
          loadConfluenceTemplates={loadConfluenceTemplates}
          providerCatalogPending={catalog._tag !== "ready"}
          runTurn={runTurn}
        />
      ) : (
        <ContextualAgentPage originPath={originPath} />
      )}
    </>
  )
}
