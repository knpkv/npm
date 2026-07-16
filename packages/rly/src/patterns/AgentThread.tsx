import type { ComponentPropsWithRef, ReactElement, ReactNode } from "react"
import { Avatar } from "../primitives/Avatar.js"
import { classNames, cssClass, requireText } from "../internal/component.js"
import type { RlyPerson } from "./Person.js"
import styles from "./AgentThread.module.css"

const style = (name: string): string => cssClass(styles, name)

const requireSlot = (value: ReactNode, label: string): void => {
  if (value === undefined || value === null || typeof value === "boolean") {
    throw new Error(`${label} must contain renderable content`)
  }
  if (typeof value === "string") requireText(value, label)
}

/** A human participant whose circular identity distinguishes them from automation. */
export interface RlyAgentThreadHumanActor {
  readonly kind: "human"
  readonly person: RlyPerson
}

/** An application-owned agent identity, always rendered as a rounded square. */
export interface RlyAgentThreadAgentActor {
  readonly kind: "agent"
  readonly id: string
  readonly name: string
  readonly role: string
  readonly avatarFallback?: string
}

/** A neutral system source for immutable operational messages. */
export interface RlyAgentThreadSystemActor {
  readonly kind: "system"
  readonly id: string
  readonly name: string
}

export type RlyAgentThreadActor = RlyAgentThreadHumanActor | RlyAgentThreadAgentActor | RlyAgentThreadSystemActor

/** One presenter-owned message in immutable display order. */
export interface RlyAgentThreadMessage {
  readonly id: string
  readonly actor: RlyAgentThreadActor
  readonly content: ReactNode
  readonly dateTime: string
  readonly time: string
  readonly evidence?: ReactNode
  readonly actions?: ReactNode
}

/** Controlled release-context conversation. rly never sends or appends messages. */
export type AgentThreadProps = Omit<ComponentPropsWithRef<"section">, "aria-label" | "children"> & {
  readonly heading: string
  readonly context: ReactNode
  readonly messages: ReadonlyArray<RlyAgentThreadMessage>
  readonly composer: ReactNode
  readonly emptyLabel?: string
  /** A presenter-supplied, short update announced politely without moving focus. */
  readonly announcement?: string
}

const initialsFor = (name: string): string => {
  const words = name.trim().split(/\s+/u)
  const first = Array.from(words[0] ?? "")[0] ?? ""
  const last = Array.from(words[words.length - 1] ?? "")[0] ?? ""
  return requireText(`${first}${words.length > 1 ? last : ""}`, "AgentThread actor fallback")
}

const validateActor = (actor: RlyAgentThreadActor): void => {
  if (actor.kind === "human") {
    requireText(actor.person.id, "AgentThread human id")
    requireText(actor.person.name, "AgentThread human name")
    requireText(actor.person.role, "AgentThread human role")
    if (actor.person.avatarFallback !== undefined) {
      requireText(actor.person.avatarFallback, "AgentThread human avatarFallback")
    }
    if (actor.person.avatarSrc !== undefined) requireText(actor.person.avatarSrc, "AgentThread human avatarSrc")
    return
  }
  requireText(actor.id, `AgentThread ${actor.kind} id`)
  requireText(actor.name, `AgentThread ${actor.kind} name`)
  if (actor.kind === "agent") {
    requireText(actor.role, "AgentThread agent role")
    if (actor.avatarFallback !== undefined) requireText(actor.avatarFallback, "AgentThread agent avatarFallback")
  }
}

const actorIdentity = (actor: RlyAgentThreadActor): ReactElement => {
  const name = actor.kind === "human" ? actor.person.name : actor.name
  const role = actor.kind === "human" ? actor.person.role : actor.kind === "agent" ? actor.role : "System event"
  const fallback =
    actor.kind === "human"
      ? (actor.person.avatarFallback ?? initialsFor(name))
      : actor.kind === "agent"
        ? (actor.avatarFallback ?? initialsFor(name))
        : "·"
  const src = actor.kind === "human" ? actor.person.avatarSrc : undefined

  return (
    <div className={classNames(style("actor"), style(actor.kind))} data-rly-agent-thread-actor={actor.kind}>
      <Avatar
        className={style("avatar")}
        data-rly-agent-thread-avatar-shape={actor.kind === "human" ? "circle" : "rounded-square"}
        decorative
        fallback={fallback}
        shape={actor.kind === "human" ? "circle" : "rounded-square"}
        size="default"
        {...(src === undefined ? {} : { src })}
      />
      <span className={style("actorText")}>
        <strong>{name}</strong>
        <span>{role}</span>
      </span>
    </div>
  )
}

/** Render exact context, ordered messages, then the required application composer. */
export const AgentThread = ({
  announcement,
  className,
  composer,
  context,
  emptyLabel = "No messages yet.",
  heading,
  messages,
  ...props
}: AgentThreadProps): ReactElement => {
  const visibleHeading = requireText(heading, "AgentThread heading")
  const visibleEmpty = requireText(emptyLabel, "AgentThread emptyLabel")
  requireSlot(context, "AgentThread context")
  requireSlot(composer, "AgentThread composer")
  if (announcement !== undefined) requireText(announcement, "AgentThread announcement")
  const ids = new Set<string>()
  for (const message of messages) {
    const id = requireText(message.id, "AgentThread message id")
    if (ids.has(id)) throw new Error(`AgentThread message ids must be unique: ${id}`)
    ids.add(id)
    validateActor(message.actor)
    requireSlot(message.content, `AgentThread message content for ${id}`)
    requireText(message.dateTime, `AgentThread message dateTime for ${id}`)
    requireText(message.time, `AgentThread message time for ${id}`)
  }

  return (
    <section {...props} className={classNames(style("root"), className)} data-rly-agent-thread="">
      <header className={style("header")}>
        <span aria-hidden="true" className={style("agentGlyph")}>
          AI
        </span>
        <h2>{visibleHeading}</h2>
      </header>
      <div className={style("context")} data-rly-agent-thread-context="">
        <span className={style("conceptLabel")}>Exact context</span>
        {context}
      </div>
      {messages.length === 0 ? (
        <p className={style("empty")}>{visibleEmpty}</p>
      ) : (
        <ol aria-label={`${visibleHeading} messages`} className={style("messages")}>
          {messages.map((message) => (
            <li className={style("message")} data-rly-agent-thread-message={message.id} key={message.id}>
              <div className={style("messageHead")}>
                {actorIdentity(message.actor)}
                <time dateTime={message.dateTime}>{message.time}</time>
              </div>
              <div className={style("content")}>{message.content}</div>
              {message.evidence === undefined ? null : (
                <div className={style("evidence")} data-rly-agent-thread-evidence="">
                  {message.evidence}
                </div>
              )}
              {message.actions === undefined ? null : (
                <div className={style("actions")} data-rly-agent-thread-actions="">
                  {message.actions}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      <p aria-atomic="true" aria-live="polite" className={style("visuallyHidden")}>
        {announcement}
      </p>
      <div className={style("composer")} data-rly-agent-thread-composer="">
        {composer}
      </div>
    </section>
  )
}
