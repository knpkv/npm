import { Bot, Check, Circle, History, MessageCircle, Pencil, Reply, Send } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import avatarMaya from "./assets/people/avatar-00.webp"
import avatarAlex from "./assets/people/avatar-01.webp"
import avatarPriya from "./assets/people/avatar-02.webp"
import type { EntityRecord } from "./control-center-foundation.js"
import type { JiraIssueComment, JiraIssueHistoryEvent, JiraIssueState } from "./control-center-state.js"
import "./control-center-jira-view.css"

export type JiraEntityTab = "Comments" | "Description" | "History"
export const jiraEntityTabs: ReadonlyArray<JiraEntityTab> = ["Description", "Comments", "History"]

type JiraHistoryRow = readonly [time: string, actor: string, event: string]

interface JiraComment {
  readonly avatar: string
  readonly body: string
  readonly id: string
  readonly name: string
  readonly reply?: string
  readonly time: string
}

interface JiraEntityViewProps {
  readonly actionComplete: boolean
  readonly object: EntityRecord
  readonly onNotice: (message: string) => void
  readonly onStateChange: (state: JiraIssueState) => void
  readonly state?: JiraIssueState
  readonly tab: JiraEntityTab
}

const fact = (object: EntityRecord, label: string) => object.facts.find(([candidate]) => candidate === label)?.[1]

const avatarFor = (name: string) =>
  name === "Maya Chen" ? avatarMaya : name === "Priya Shah" ? avatarPriya : avatarAlex

export function JiraEntityView({
  actionComplete,
  object,
  onNotice,
  onStateChange,
  state = {},
  tab
}: JiraEntityViewProps) {
  const sourceDescription = object.tabs.Primary?.[0] ?? object.title
  const criteria = object.tabs.Primary?.slice(1) ?? []
  const description = state.description ?? sourceDescription
  const checkedCriteria = state.checkedCriteria ?? criteria.slice(1)
  const [editing, setEditing] = useState(false)
  const [draftDescription, setDraftDescription] = useState(description)
  const [commentDraft, setCommentDraft] = useState("")
  const [replyTarget, setReplyTarget] = useState<JiraComment | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const initialComments: ReadonlyArray<JiraComment> = [
    {
      avatar: avatarMaya,
      body: `I verified the release boundary. ${
        fact(object, "RELEASE") ?? fact(object, "WORKSTREAM") ?? "This workstream"
      } is the only delivery affected.`,
      id: "maya-boundary",
      name: "Maya Chen",
      reply: "Release Guardian rechecked the linked PR and pipeline after this note.",
      time: "Today, 09:42"
    },
    {
      avatar: avatarAlex,
      body: "Implementation evidence is attached. The remaining acceptance checks can be reviewed independently.",
      id: "alex-evidence",
      name: "Alex Kim",
      time: "Today, 09:18"
    },
    {
      avatar: avatarPriya,
      body: "No additional rollout risk from my side. Keep the operational evidence linked when this moves to review.",
      id: "priya-risk",
      name: "Priya Shah",
      time: "Yesterday, 16:31"
    }
  ]
  const customComments = state.comments ?? []
  const comments: ReadonlyArray<JiraComment> = [
    ...customComments
      .filter(({ parentId }) => parentId == null)
      .map((comment) => ({
        ...comment,
        avatar: avatarFor(comment.name)
      })),
    ...initialComments
  ]
  const appendHistory = (event: JiraIssueHistoryEvent, patch: JiraIssueState) => {
    onStateChange({ ...state, ...patch, history: [event, ...(state.history ?? [])] })
  }
  useEffect(() => {
    if (replyTarget) composerRef.current?.focus()
  }, [replyTarget])

  if (tab === "Comments") {
    return (
      <div className="cc-jira-view cc-jira-comments">
        <div className="cc-jira-section-heading">
          <span>
            <MessageCircle size={16} />
          </span>
          <div>
            <h3>Conversation</h3>
            <p>
              {comments.length + customComments.filter(({ parentId }) => parentId != null).length} comments ·
              collaborators and agent checks
            </p>
          </div>
        </div>
        <div className="cc-jira-comment-list">
          {comments.map((comment) => (
            <article key={comment.id}>
              <img alt="" src={comment.avatar} />
              <div>
                <header>
                  <b>{comment.name}</b>
                  <time>{comment.time}</time>
                </header>
                <p>{comment.body}</p>
                <button
                  aria-pressed={replyTarget?.id === comment.id}
                  onClick={() => {
                    setReplyTarget(comment)
                    setCommentDraft(`@${comment.name} `)
                    onNotice(`Replying to ${comment.name}`)
                  }}
                >
                  <Reply size={12} />
                  Reply
                </button>
                {comment.reply && (
                  <aside>
                    <Bot size={14} />
                    <span>
                      <b>Release Guardian</b>
                      {comment.reply}
                    </span>
                  </aside>
                )}
                {customComments
                  .filter(({ parentId }) => parentId === comment.id)
                  .map((reply) => (
                    <aside className="human-reply" key={reply.id}>
                      <img alt="" src={avatarFor(reply.name)} />
                      <span>
                        <b>{reply.name}</b>
                        {reply.body}
                        <small>{reply.time}</small>
                      </span>
                    </aside>
                  ))}
              </div>
            </article>
          ))}
        </div>
        <form
          className="cc-jira-comment-compose"
          onSubmit={(event) => {
            event.preventDefault()
            const body = commentDraft.trim()
            if (!body) return
            const comment: JiraIssueComment = {
              body,
              id: `local-${customComments.length + 1}`,
              name: "Alex Kim",
              ...(replyTarget ? { parentId: replyTarget.id } : {}),
              time: "Just now"
            }
            appendHistory(
              {
                actor: "Alex Kim",
                label: replyTarget ? `Replied to ${replyTarget.name}` : "Added a comment",
                time: "Just now"
              },
              { comments: [comment, ...customComments] }
            )
            setCommentDraft("")
            setReplyTarget(null)
            onNotice(replyTarget ? `Reply added to ${replyTarget.name}` : "Comment added")
          }}
        >
          <img alt="" src={avatarAlex} />
          <textarea
            aria-label="Add a comment"
            onChange={(event) => setCommentDraft(event.target.value)}
            placeholder={replyTarget ? `Reply to ${replyTarget.name}…` : "Add context for the people shipping this…"}
            ref={composerRef}
            value={commentDraft}
          />
          <button disabled={!commentDraft.trim()} type="submit">
            <Send size={14} />
            Add comment
          </button>
        </form>
      </div>
    )
  }

  if (tab === "History") {
    const events: ReadonlyArray<JiraHistoryRow> = [
      ...(state.history ?? []).map(({ actor, label, time }): JiraHistoryRow => [time, actor, label]),
      ["Today, 10:06", "Release Guardian", "Relationship evidence checked across Jira, code, and pipeline"],
      ["Today, 09:42", "Maya Chen", `Confirmed scope for ${fact(object, "RELEASE") ?? "the active workstream"}`],
      ["Today, 09:18", "Alex Kim", "Updated description and attached implementation evidence"],
      ...object.activity.map((event, index): JiraHistoryRow => [`Yesterday, ${16 - index}:2${index}`, "System", event])
    ]
    return (
      <div className="cc-jira-view cc-jira-history">
        <div className="cc-jira-section-heading">
          <span>
            <History size={16} />
          </span>
          <div>
            <h3>Issue history</h3>
            <p>Human decisions and synchronized delivery evidence</p>
          </div>
        </div>
        <ol>
          {events.map(([time, actor, event], index) => (
            <li key={`${actor}-${event}`}>
              <i className={index === 0 ? "current" : ""} />
              <time>{time}</time>
              <div>
                <b>{actor}</b>
                <p>{event}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    )
  }

  return (
    <div className="cc-jira-view cc-jira-description">
      <section>
        <div className="cc-jira-section-heading">
          <span>
            <Pencil size={16} />
          </span>
          <div>
            <h3>Description</h3>
            <p>What changes, why it matters, and where the boundary ends</p>
          </div>
          <button
            onClick={() => {
              setDraftDescription(description)
              setEditing((current) => !current)
            }}
          >
            {editing ? "Cancel" : "Edit"}
          </button>
        </div>
        {editing ? (
          <div className="cc-jira-description-editor">
            <textarea onChange={(event) => setDraftDescription(event.target.value)} value={draftDescription} />
            <button
              onClick={() => {
                const nextDescription = draftDescription.trim() || sourceDescription
                appendHistory(
                  {
                    actor: "Alex Kim",
                    label: "Updated the issue description",
                    time: "Just now"
                  },
                  { description: nextDescription }
                )
                setEditing(false)
                onNotice("Issue description updated")
              }}
            >
              Update description
            </button>
          </div>
        ) : (
          <div className="cc-jira-copy">
            <p>{description}</p>
            <p>
              The change should be observable through the linked delivery evidence without widening the release scope.
              Reviewers can validate behavior from this issue, its implementation, and the current pipeline execution.
            </p>
          </div>
        )}
      </section>
      <section className="cc-jira-criteria">
        <div className="cc-jira-section-heading">
          <span>
            <Check size={16} />
          </span>
          <div>
            <h3>Acceptance criteria</h3>
            <p>{criteria.length} independently verifiable outcomes</p>
          </div>
        </div>
        <div>
          {criteria.map((criterion) => {
            const checked = actionComplete || checkedCriteria.includes(criterion)
            return (
              <button
                className={checked ? "checked" : ""}
                disabled={actionComplete}
                key={criterion}
                onClick={() => {
                  const nextCriteria = checkedCriteria.includes(criterion)
                    ? checkedCriteria.filter((candidate) => candidate !== criterion)
                    : [...checkedCriteria, criterion]
                  appendHistory(
                    {
                      actor: "Alex Kim",
                      label: `${checked ? "Reopened" : "Verified"} acceptance check: ${criterion.replace(
                        /^Acceptance · /,
                        ""
                      )}`,
                      time: "Just now"
                    },
                    { checkedCriteria: nextCriteria }
                  )
                  onNotice(checked ? "Acceptance check reopened" : "Acceptance check verified")
                }}
              >
                {checked ? <Check size={15} /> : <Circle size={15} />}
                <span>
                  <b>{criterion.replace(/^Acceptance · /, "")}</b>
                  <small>{checked ? "Verified" : "Needs review"}</small>
                </span>
              </button>
            )
          })}
        </div>
      </section>
      <section className="cc-jira-scope">
        <div>
          <small>OWNER</small>
          <b>{fact(object, "OWNER") ?? "Unassigned"}</b>
        </div>
        <div>
          <small>DELIVERY</small>
          <b>{fact(object, "RELEASE") ?? fact(object, "WORKSTREAM")}</b>
        </div>
        <div>
          <small>PRIORITY</small>
          <b>{fact(object, "PRIORITY") ?? "Normal"}</b>
        </div>
      </section>
    </div>
  )
}
