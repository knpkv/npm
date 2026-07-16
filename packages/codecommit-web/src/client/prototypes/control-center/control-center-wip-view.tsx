import { Activity, Bot, Check, Sparkles } from "lucide-react"
import { CollaboratorStack, wipCollaborators } from "./control-center-collaborators.js"
import { ServiceIcon, type WorkflowEvent } from "./control-center-foundation.js"
import { resolveEntity, wipWorkset } from "./control-center-model.js"
import type { ReviewState } from "./control-center-state.js"

const entityForWipEvent = (label: string, detail: string): string => {
  if (label.includes("Runbook") || detail.includes("Confluence")) return "page:RUN-70"
  if (label.includes("PR #293")) return "pr:billing-service:293"
  if (label.includes("pushed") || detail.includes("Commit")) return "pr:billing-service:291"
  if (label.includes("Observability") || detail.includes("PR #293")) return "pipeline:observability-preview:774"
  return "pipeline:billing-preview:1852"
}

interface WipViewProps {
  readonly entityActions: Readonly<Record<string, boolean>>
  readonly onAdvanceReview: () => void
  readonly onGuide: () => void
  readonly onOpenEntity: (entityId: string) => void
  readonly reviewState: ReviewState
  readonly reviewStates: Readonly<Record<string, ReviewState>>
  readonly workflowActivity: ReadonlyArray<WorkflowEvent>
}

export function WipView({
  entityActions,
  onAdvanceReview,
  onGuide,
  onOpenEntity,
  reviewState,
  reviewStates,
  workflowActivity
}: WipViewProps) {
  return (
    <section className="cc-wip-view">
      <header>
        <div>
          <span>OPS-428 · ACTIVE WORK</span>
          <h1>{reviewState === "reviewed" ? "Ready to merge." : "Ready for review."}</h1>
          <p>
            {reviewState === "reviewed"
              ? "Review approved. PR #293 is ready to merge."
              : "Retry policy is implemented. Preview passed; review is next."}
          </p>
          <CollaboratorStack people={wipCollaborators} />
        </div>
        <button onClick={onGuide}>
          <Sparkles size={18} />
          Guide the agent
        </button>
      </header>
      <div className="cc-wip-state">
        <div>
          <small>CURRENT</small>
          <b>{reviewState === "reviewed" ? "Merge PR #293" : "Review PR #293"}</b>
          <span>{reviewState === "reviewed" ? "Maya approved all changes" : "Release Guardian prepared evidence"}</span>
        </div>
        <div>
          <small>PREVIEW</small>
          <b>64 / 64 passed</b>
          <span>billing-preview #1852</span>
        </div>
        <div>
          <small>NEXT</small>
          <b>{reviewState === "reviewed" ? "Merge and release planning" : "Human review"}</b>
          <span>
            {reviewState === "not-requested"
              ? "Maya Chen · not requested"
              : reviewState === "requested"
                ? "Maya Chen · requested"
                : "Maya Chen · approved"}
          </span>
        </div>
      </div>
      <section className="cc-release-workset">
        <header>
          <div>
            <ServiceIcon service="jira" />
            <span>
              <small>WIP INCLUDED</small>
              <b>6 Jira items</b>
            </span>
          </div>
          <span>2 PRs · 3 previews · no gaps</span>
        </header>
        <div className="cc-workset-grid">
          <div className="cc-jira-set">
            <div className="cc-pr-groups">
              {wipWorkset.prs.map(([pr, keys], groupIndex) => (
                <section className="cc-pr-group" key={pr}>
                  <button
                    className="cc-pr-group-head"
                    onClick={() => onOpenEntity(`pr:billing-service:${pr.replace("#", "")}`)}
                  >
                    <ServiceIcon service="code" />
                    <span>
                      <small>PULL REQUEST</small>
                      <b>PR {pr}</b>
                    </span>
                    <em>
                      {reviewStates[`pr:billing-service:${pr.replace("#", "")}`] === "reviewed"
                        ? "Review complete"
                        : reviewStates[`pr:billing-service:${pr.replace("#", "")}`] === "requested" ||
                            entityActions[`pr:billing-service:${pr.replace("#", "")}`]
                          ? "Review requested"
                          : groupIndex === 0
                            ? "Preview passed"
                            : "Review pending"}
                    </em>
                  </button>
                  <div>
                    {keys.map((key) => {
                      const ticket = wipWorkset.tickets.find(([ticketKey]) => ticketKey === key)!
                      const transitionComplete = entityActions[`jira:${key}`] === true
                      return (
                        <button
                          className={`cc-ticket-core ${transitionComplete ? "done transitioned" : "done"}`}
                          key={key}
                          onClick={() => onOpenEntity(`jira:${key}`)}
                        >
                          <i>
                            {transitionComplete || (key !== "OPS-428" && key !== "OBS-42") ? (
                              <Check size={11} />
                            ) : (
                              <Activity size={11} />
                            )}
                          </i>
                          <span>
                            <small>
                              {key} · {transitionComplete ? "Moved to review" : ticket[2]}
                            </small>
                            <b>{ticket[1]}</b>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </section>
              ))}
            </div>
            <div className="cc-wip-agent-note">
              <Bot size={16} />
              <span>
                <b>Release Guardian</b>
                <small>
                  {reviewState === "not-requested"
                    ? "Added retry jitter, reran preview, and prepared reviewer context."
                    : reviewState === "requested"
                      ? "Review requested from Maya Chen; monitoring for feedback."
                      : "Maya approved the review; ready for merge."}
                </small>
              </span>
              <button disabled={reviewState === "reviewed"} onClick={onAdvanceReview}>
                {reviewState === "not-requested"
                  ? "Request review"
                  : reviewState === "requested"
                    ? "Mark reviewed"
                    : "Review complete"}
              </button>
            </div>
          </div>
          <aside className="cc-pipeline-stream">
            <header>
              <ServiceIcon service="pipeline" />
              <span>
                <small>PREVIEW PASSED</small>
                <b>billing-preview #1852 · 64/64 checks</b>
              </span>
              <i className="passed" />
            </header>
            {Object.entries(entityActions)
              .filter(
                ([entityId, completed]) => completed && wipWorkset.tickets.some(([key]) => entityId === `jira:${key}`)
              )
              .map(([entityId]) => {
                const issue = resolveEntity(entityId)
                const audit = workflowActivity.find((event) => event.label.includes(issue.title))
                return (
                  <button className="passed" key={entityId} onClick={() => onOpenEntity(entityId)}>
                    <span>{audit?.time ?? "Recorded"}</span>
                    <b>Moved to review</b>
                    <small>{issue.title}</small>
                  </button>
                )
              })}
            {reviewState !== "not-requested" && (
              <button
                className={reviewState === "reviewed" ? "passed" : "waiting"}
                onClick={() => onOpenEntity("pr:billing-service:293")}
              >
                <span>10:24</span>
                <b>{reviewState === "reviewed" ? "Review completed" : "Review requested"}</b>
                <small>Maya Chen · PR #293</small>
              </button>
            )}
            {wipWorkset.events.map(([time, label, detail], index) => (
              <button
                className={index === 1 ? "passed" : index === 0 ? "waiting" : ""}
                key={`${time}-${label}`}
                onClick={() => onOpenEntity(entityForWipEvent(label, detail))}
              >
                <span>{time}</span>
                <b>{label}</b>
                <small>{detail}</small>
              </button>
            ))}
          </aside>
        </div>
      </section>
      <footer>
        <ServiceIcon service="confluence" />
        <b>RUN-70</b>
        <span>Provider degradation response · updated 10:09</span>
        <button onClick={() => onOpenEntity("page:RUN-70")}>Open runbook</button>
      </footer>
    </section>
  )
}
