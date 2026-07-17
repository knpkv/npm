import { AgentThread, PeopleStrip, ReleaseRelay, type RlyAgentThreadMessage } from "@knpkv/rly/patterns"
import { Button, Field, StatePanel, Surface, Text } from "@knpkv/rly/primitives"
import * as DateTime from "effect/DateTime"
import * as Predicate from "effect/Predicate"
import { type FormEvent, type ReactElement, useEffect, useMemo, useRef, useState } from "react"
import { Link, useLocation, useOutletContext, useParams, useSearchParams } from "react-router"

import type { PortfolioReleaseSummary } from "../api/portfolio.js"
import type { EventCursor, ReleaseId, WorkspaceId } from "../domain/identifiers.js"
import type { PortfolioReleasePresentation } from "./portfolio/presentPortfolio.js"
import {
  decodeReleaseRouteId,
  decodeWorkspaceRouteId,
  releaseFullPath,
  releaseTransitionNames
} from "./releases/releaseRoutes.js"
import {
  readReleaseAgentThread,
  type StoredReleaseAgentThreadMessage,
  writeReleaseAgentThread
} from "./releases/releaseAgentThreadStorage.js"
import type { WorkspaceReleaseOutletContext } from "./releases/WorkspaceReleaseLayout.js"
import { runBrowserReleaseAgentTurn } from "./releases/releaseAgentTransport.js"
import styles from "./AgentPage.module.css"

export interface ReleaseAgentHistoryMessage {
  readonly content: string
  readonly role: "assistant" | "user"
}

export interface ReleaseAgentTurnInput {
  readonly history: ReadonlyArray<ReleaseAgentHistoryMessage>
  readonly prompt: string
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

export interface AgentPageProps {
  /** Application-owned local runtime boundary. Omit it to render an honest unavailable state. */
  readonly runTurn?: ReleaseAgentTurn
}

interface AgentPageContext {
  readonly description: string
  readonly label: string
  readonly path: string | null
}

type LocalThreadMessage = StoredReleaseAgentThreadMessage

type TurnFailure = "blocked" | "failed" | "not-found" | "rate-limited" | "session-expired" | "timed-out" | "unavailable"

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

const contextFor = (path: string | null): AgentPageContext => {
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
    return {
      description: `Current normalized delivery items in workspace ${workspaceId}, including the exact active filters and selection.`,
      label: "Workspace items",
      path: safePath
    }
  }
  if (isWorkspaceCollectionRoute && workspaceId !== null && routeKind === "work" && releaseId === null) {
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

const SUGGESTIONS: ReadonlyArray<string> = [
  "What blocks this release?",
  "Write a concise release summary.",
  "Which evidence is still missing?"
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
  prompt
}: {
  readonly disabled: boolean
  readonly isRunning: boolean
  readonly onPromptChange: (prompt: string) => void
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void
  readonly prompt: string
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
      Ask Relay
    </Button>
  </form>
)

const ReleaseAgentRoom = ({
  release,
  runTurn,
  workspaceId
}: {
  readonly release: PortfolioReleasePresentation
  readonly runTurn: ReleaseAgentTurn | undefined
  readonly workspaceId: WorkspaceId
}): ReactElement => {
  const location = useLocation()
  const [prompt, setPrompt] = useState("")
  const [messages, setMessages] = useState<ReadonlyArray<LocalThreadMessage>>(() => readReleaseAgentThread(release.id))
  const [failure, setFailure] = useState<TurnFailure | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [announcement, setAnnouncement] = useState("")
  const nextMessage = useRef(nextThreadSequence(messages))
  const activeTurn = useRef<AbortController | null>(null)
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

  const threadMessages = useMemo(() => presentMessages(messages), [messages])
  const lastProvider = [...messages].reverse().find((message) => message.provider !== undefined)?.provider
  const runtimeUnavailable = runTurn === undefined

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const submittedPrompt = prompt.trim()
    if (submittedPrompt.length === 0 || runTurn === undefined || isRunning) return
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

    runTurn(
      { history, prompt: submittedPrompt, releaseId: release.id, workspaceId },
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

  return (
    <article className={styles.room} data-release-agent-id={release.id}>
      <Link className={styles.back} state={location.state} to={releaseFullPath(workspaceId, release.id)}>
        Back to release
      </Link>
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

      <section aria-labelledby="agent-starters" className={styles.starters}>
        <Text as="h2" id="agent-starters" tone="secondary" variant="label">
          Start with one question
        </Text>
        <div className={styles.suggestionList}>
          {SUGGESTIONS.map((suggestion) => (
            <button
              className={styles.suggestion}
              disabled={runtimeUnavailable || isRunning}
              key={suggestion}
              onClick={() => setPrompt(suggestion)}
              type="button"
            >
              {suggestion}
            </button>
          ))}
        </div>
      </section>

      {runtimeUnavailable ? (
        <StatePanel
          description="Connect the server to a local Codex or Claude runner. Provider credentials and repository access stay server-side; this tab stores its bounded thread locally."
          title="Local agent not connected"
        />
      ) : null}
      {failure === null ? null : <div className={styles.failure}>{failurePanel(failure)}</div>}

      <AgentThread
        {...(announcement.length === 0 ? {} : { announcement })}
        className={styles.thread}
        composer={
          <ReleaseAgentComposer
            disabled={runtimeUnavailable}
            isRunning={isRunning}
            onPromptChange={setPrompt}
            onSubmit={onSubmit}
            prompt={prompt}
          />
        }
        context={
          <div className={styles.threadContext}>
            <strong>{release.serviceName}</strong>
            <span>{release.version}</span>
            <span>{release.relay.codename}</span>
            {lastProvider === undefined ? null : <span>Local {lastProvider}</span>}
          </div>
        }
        emptyLabel="Ask one useful question. Relay will answer only for this release."
        heading="Release thread"
        messages={threadMessages}
      />
    </article>
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
    </section>
  )
}

/** Render an exact release-owned local agent thread, with a safe legacy context preview. */
export const AgentPage = ({ runTurn }: AgentPageProps): ReactElement => {
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
  return <ReleaseAgentRoom key={release.id} release={release} runTurn={runTurn} workspaceId={workspaceId} />
}

/** Route entry wired to the authenticated Control Center release-agent API. */
export const ConnectedAgentPage = (): ReactElement => <AgentPage runTurn={runBrowserReleaseAgentTurn} />
