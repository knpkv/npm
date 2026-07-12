import { ArrowRight, ShieldCheck, Sparkles } from "lucide-react"
import type { Dispatch, SetStateAction } from "react"
import { CollaboratorStack, releaseCollaborators } from "./control-center-collaborators.js"
import { ServiceIcon } from "./control-center-foundation.js"
import { releaseWorksets } from "./control-center-model.js"
import { ReleaseSigil } from "./control-center-release-sigil.js"

type PortfolioFilter = "all" | "attention" | "deploying" | "shipped"
interface PortfolioRelease {
  readonly action: string
  readonly detail: string
  readonly service: string
  readonly stages: ReadonlyArray<string>
  readonly state: string
  readonly tone: string
  readonly version: string
}

interface PortfolioViewProps {
  readonly entityLinks: Readonly<Record<string, string>>
  readonly filter: PortfolioFilter
  readonly fixesApplied: boolean
  readonly hasAttention: (index: number) => boolean
  readonly onAsk: () => void
  readonly onOpenRelease: (service: string) => void
  readonly releases: ReadonlyArray<PortfolioRelease>
  readonly remainingGaps: (index: number) => number
  readonly setFilter: Dispatch<SetStateAction<PortfolioFilter>>
  readonly visibleReleases: ReadonlyArray<PortfolioRelease>
}

export function PortfolioView({
  entityLinks,
  filter,
  fixesApplied,
  hasAttention,
  onAsk,
  onOpenRelease,
  releases,
  remainingGaps,
  setFilter,
  visibleReleases
}: PortfolioViewProps) {
  return (
    <section className="cc-bird-view">
      <header>
        <div>
          <span>6 RELEASES · 5 CONNECTED SERVICES</span>
          <h1>What can ship?</h1>
          <p>Release Guardian checked every service 18 seconds ago.</p>
          <div className="cc-source-legend" aria-label="Connected services">
            <span className="aws">
              <ServiceIcon service="code" />
              CodeCommit
            </span>
            <span className="aws">
              <ServiceIcon service="pipeline" />
              CodePipeline
            </span>
            <span className="atlassian">
              <ServiceIcon service="jira" />
              Jira
            </span>
            <span className="atlassian">
              <ServiceIcon service="confluence" />
              Confluence
            </span>
            <span className="clockify">
              <ServiceIcon service="clockify" />
              Clockify
            </span>
          </div>
        </div>
        <button onClick={onAsk}>
          <Sparkles size={18} />
          Ask Release Guardian
        </button>
      </header>
      <div className="cc-bird-summary">
        <SummaryFilter
          active={filter === "all"}
          count={releases.length}
          label="All releases"
          onClick={() => setFilter("all")}
        />
        <SummaryFilter
          active={filter === "attention"}
          attention
          count={releases.filter((_, index) => hasAttention(index)).length}
          label="Need attention"
          onClick={() => setFilter("attention")}
        />
        <SummaryFilter
          active={filter === "deploying"}
          count={releases.filter(({ tone }) => tone === "moving").length}
          label="Deploying now"
          onClick={() => setFilter("deploying")}
        />
        <SummaryFilter
          active={filter === "shipped"}
          count={releases.filter(({ tone }) => tone === "shipped").length}
          label="Shipped today"
          onClick={() => setFilter("shipped")}
        />
      </div>
      <div className="cc-release-board-head" aria-hidden="true">
        <span />
        <div>
          <span>BUILD</span>
          <span>VERIFY</span>
          <span>PRODUCTION</span>
        </div>
        <span />
      </div>
      <div className="cc-release-board">
        {visibleReleases.map((release) => {
          const releaseIndex = releases.findIndex(({ service }) => service === release.service)
          const pullRequestCount =
            release.service === "payments-api" && fixesApplied
              ? 3
              : entityLinks["jira:RISK-61"] && release.service === "risk-engine"
                ? releaseWorksets[releaseIndex]!.prs.length + 1
                : releaseWorksets[releaseIndex]!.prs.length
          const gapCount = remainingGaps(releaseIndex)
          return (
            <article className={release.tone} key={release.service}>
              <button
                className="cc-release-main"
                aria-label={`Open ${release.service} ${release.version}: ${release.state}`}
                onClick={() => onOpenRelease(release.service)}
              >
                <span className="cc-release-signal" />
                <span className="cc-release-name">
                  <small>{release.service}</small>
                  <b>{release.version}</b>
                  <ReleaseSigil service={release.service} />
                </span>
                <strong>{release.state}</strong>
                <div className="cc-release-detail">
                  {release.detail}
                  <small className="cc-release-relations">
                    6 Jira · {pullRequestCount} PRs · 1 pipeline
                    {gapCount === 0 ? " · complete" : ` · ${gapCount} missing`}
                  </small>
                  <CollaboratorStack people={releaseCollaborators[release.service] ?? []} />
                </div>
              </button>
              <div className="cc-release-stages">
                {release.stages.map((stage, stageIndex) => (
                  <span
                    className={
                      stage === "Failed"
                        ? "failed"
                        : stage === "Live" || stage === "Ready" || stage === "Passed" || stage === "Built"
                          ? "passed"
                          : ""
                    }
                    key={`${stage}-${stageIndex}`}
                  >
                    <i />
                    {stage}
                  </span>
                ))}
              </div>
              <button className="cc-release-action" onClick={() => onOpenRelease(release.service)}>
                {release.action}
                <ArrowRight size={16} />
              </button>
            </article>
          )
        })}
      </div>
      <footer>
        <ShieldCheck size={16} />
        <span>
          <b>Release Guardian</b> found{" "}
          {(() => {
            const remaining = releaseWorksets.reduce((total, _, index) => total + remainingGaps(index), 0)
            const affected = releaseWorksets.filter((_, index) => remainingGaps(index) > 0).length
            return `${remaining} evidence gaps across ${affected} releases`
          })()}
          .
        </span>
        <button onClick={onAsk}>Review portfolio</button>
      </footer>
    </section>
  )
}

function SummaryFilter({
  active,
  attention = false,
  count,
  label,
  onClick
}: {
  readonly active: boolean
  readonly attention?: boolean
  readonly count: number
  readonly label: string
  readonly onClick: () => void
}) {
  return (
    <button
      aria-pressed={active}
      className={`${active ? "active" : ""}${attention ? " attention" : ""}`.trim()}
      onClick={onClick}
    >
      <b>{count}</b>
      <span>{label}</span>
    </button>
  )
}
