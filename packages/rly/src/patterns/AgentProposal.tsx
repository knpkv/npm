import { type ComponentPropsWithRef, type ReactElement, type ReactNode, useId } from "react"
import { Avatar } from "../primitives/Avatar.js"
import { classNames, cssClass, requireText } from "../internal/component.js"
import styles from "./AgentProposal.module.css"

const style = (name: string): string => cssClass(styles, name)

/** Presentation-only identity for the agent that authored a proposal. */
export interface RlyAgentIdentity {
  readonly id: string
  readonly name: string
  readonly role: string
  readonly avatarFallback: string
  readonly avatarSrc?: string
}

/** One immutable, presenter-supplied evidence reference. */
export interface RlyAgentProposalEvidence {
  readonly id: string
  readonly label: string
  readonly reference: string
}

/** Exact proposal projection shared by proposal and human-review surfaces. */
export interface RlyAgentProposal {
  readonly id: string
  readonly agent: RlyAgentIdentity
  readonly capability: string
  readonly context: string
  readonly evidence: ReadonlyArray<RlyAgentProposalEvidence>
  readonly expectedRevision: string
  readonly impact: string
  readonly target: string
}

/** Props for an explicitly non-authorizing agent proposal. */
export type AgentProposalProps = Omit<ComponentPropsWithRef<"section">, "children"> & {
  readonly outcome: ReactNode
  readonly proposal: RlyAgentProposal
  readonly state: ReactNode
}

const validateAgent = (agent: RlyAgentIdentity): void => {
  requireText(agent.id, "AgentProposal agent id")
  requireText(agent.name, "AgentProposal agent name")
  requireText(agent.role, "AgentProposal agent role")
  requireText(agent.avatarFallback, "AgentProposal agent avatarFallback")
  if (agent.avatarSrc !== undefined) requireText(agent.avatarSrc, "AgentProposal agent avatarSrc")
}

/** Validate and return an exact proposal projection without deriving authority or domain state. */
export const validateAgentProposal = (proposal: RlyAgentProposal): RlyAgentProposal => {
  requireText(proposal.id, "AgentProposal id")
  validateAgent(proposal.agent)
  requireText(proposal.capability, "AgentProposal capability")
  requireText(proposal.context, "AgentProposal context")
  requireText(proposal.expectedRevision, "AgentProposal expectedRevision")
  requireText(proposal.impact, "AgentProposal impact")
  requireText(proposal.target, "AgentProposal target")
  if (proposal.evidence.length === 0) throw new Error("AgentProposal evidence must contain at least one reference")
  const evidenceIds = new Set<string>()
  for (const evidence of proposal.evidence) {
    const evidenceId = requireText(evidence.id, "AgentProposal evidence id")
    if (evidenceIds.has(evidenceId)) throw new Error(`AgentProposal evidence ids must be unique: ${evidenceId}`)
    evidenceIds.add(evidenceId)
    requireText(evidence.label, `AgentProposal evidence label for ${evidenceId}`)
    requireText(evidence.reference, `AgentProposal evidence reference for ${evidenceId}`)
  }
  return proposal
}

/** Render an agent-authored proposal while explicitly withholding human authorization. */
export const AgentProposal = ({
  className,
  outcome,
  proposal: suppliedProposal,
  state,
  ...props
}: AgentProposalProps): ReactElement => {
  const proposal = validateAgentProposal(suppliedProposal)
  const headingId = `rly-agent-proposal-${useId()}`
  const referenceId = `rly-agent-proposal-reference-${useId()}`

  return (
    <section
      {...props}
      aria-labelledby={`${headingId} ${referenceId}`}
      className={classNames(style("root"), className)}
      data-rly-agent-proposal-id={proposal.id}
    >
      <header className={style("header")}>
        <div className={style("agentIdentity")}>
          <Avatar
            decorative
            fallback={proposal.agent.avatarFallback}
            shape="rounded-square"
            {...(proposal.agent.avatarSrc === undefined ? {} : { src: proposal.agent.avatarSrc })}
          />
          <div className={style("agentText")}>
            <p className={style("eyebrow")}>Agent proposal</p>
            <h2 className={style("heading")} id={headingId}>
              {proposal.agent.name}
            </h2>
            <p className={style("agentRole")}>{proposal.agent.role}</p>
            <code className={style("proposalReference")} id={referenceId}>
              {proposal.id}
            </code>
          </div>
        </div>
        <div className={style("state")} data-rly-agent-proposal-slot="state">
          {state}
        </div>
      </header>

      <p className={style("boundary")}>This is an agent proposal. It is not human authorization.</p>
      <p className={style("context")}>
        <span>Context</span>
        {proposal.context}
      </p>

      <dl className={style("facts")}>
        <div>
          <dt>Capability</dt>
          <dd>{proposal.capability}</dd>
        </div>
        <div>
          <dt>Target</dt>
          <dd>{proposal.target}</dd>
        </div>
        <div>
          <dt>Expected revision</dt>
          <dd>{proposal.expectedRevision}</dd>
        </div>
        <div>
          <dt>Impact</dt>
          <dd>{proposal.impact}</dd>
        </div>
      </dl>

      <div className={style("evidence")} data-rly-agent-proposal-evidence="">
        <h3>Evidence</h3>
        <ul>
          {proposal.evidence.map((evidence) => (
            <li key={evidence.id}>
              <span>{evidence.label}</span>
              <code>{evidence.reference}</code>
            </li>
          ))}
        </ul>
      </div>

      <div className={style("outcome")} data-rly-agent-proposal-slot="outcome">
        <h3>Outcome</h3>
        {outcome}
      </div>
    </section>
  )
}
