import { StageRail } from "@knpkv/rly/patterns"
import { StateLabel, Text } from "@knpkv/rly/primitives"
import type { ReactElement, ReactNode } from "react"

import type { WorkspacePipelineExecutionPresentation } from "./presentWorkspacePipelineExecution.js"
import styles from "./WorkspacePipelineExecutionDetails.module.css"

const Section = ({
  children,
  heading,
  meta
}: {
  readonly children: ReactNode
  readonly heading: string
  readonly meta: string
}): ReactElement => (
  <section className={styles.section}>
    <header className={styles.sectionHeading}>
      <Text as="h2" variant="section-title">
        {heading}
      </Text>
      <Text tone="secondary" variant="meta">
        {meta}
      </Text>
    </header>
    {children}
  </section>
)

const Timestamp = ({ value }: { readonly value: WorkspacePipelineExecutionPresentation["startedAt"] }): ReactElement =>
  value === null ? <>Not synchronized</> : <time dateTime={value.dateTime}>{value.label}</time>

/** Render one immutable CodePipeline execution as an operator-readable flight recorder. */
export const WorkspacePipelineExecutionDetails = ({
  pipeline
}: {
  readonly pipeline: WorkspacePipelineExecutionPresentation
}): ReactElement => (
  <article className={styles.document} data-workspace-pipeline-execution-detail>
    <section aria-label="Execution identity" className={styles.hero}>
      <div className={styles.heroHeading}>
        <span>Execution</span>
        <strong>{pipeline.executionId}</strong>
        <StateLabel
          label={pipeline.status}
          tone={
            pipeline.status === "Succeeded"
              ? "positive"
              : pipeline.status === "Failed"
                ? "critical"
                : pipeline.status === "Running"
                  ? "progress"
                  : pipeline.status === "Stopped"
                    ? "caution"
                    : "neutral"
          }
        />
      </div>
      {pipeline.statusSummary === null ? null : <p className={styles.summary}>{pipeline.statusSummary}</p>}
      <dl className={styles.heroFacts}>
        <div>
          <dt>Why</dt>
          <dd>
            {pipeline.triggerType}
            <small>{pipeline.triggerDetail}</small>
          </dd>
        </div>
        <div>
          <dt>Revision</dt>
          <dd>
            <code>{pipeline.triggerRevision}</code>
          </dd>
        </div>
        <div>
          <dt>Where</dt>
          <dd>{pipeline.targetEnvironment}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{pipeline.duration}</dd>
        </div>
      </dl>
      <dl className={styles.executionMeta}>
        <div>
          <dt>Pipeline</dt>
          <dd>
            {pipeline.pipelineName} · {pipeline.pipelineVersion}
          </dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>
            <Timestamp value={pipeline.startedAt} />
          </dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>
            <Timestamp value={pipeline.updatedAt} />
          </dd>
        </div>
        <div>
          <dt>Mode</dt>
          <dd>{pipeline.executionMode}</dd>
        </div>
      </dl>
    </section>

    <StageRail
      className={styles.stageRail}
      emptyLabel="No stage detail was synchronized for this execution."
      heading="Execution path"
      stages={pipeline.stages}
    />

    <Section heading="People" meta="Provider identities that operated or approved this run">
      <div className={styles.peopleLanes}>
        <div>
          <small>Operators</small>
          <strong>{pipeline.operators.join(" · ") || "Not synchronized"}</strong>
        </div>
        <div>
          <small>Approvers</small>
          <strong>{pipeline.approvers.join(" · ") || "No approval recorded"}</strong>
        </div>
      </div>
    </Section>

    <Section
      heading="Actions"
      meta={`${pipeline.actionCountLabel} actions · ${String(pipeline.pagesRead)} bounded pages read`}
    >
      {pipeline.actionsTruncated ? (
        <p className={styles.partial}>This is a bounded view. Additional action detail exists in CodePipeline.</p>
      ) : null}
      {pipeline.actions.length === 0 ? (
        <Text tone="secondary">No action detail was synchronized for this execution.</Text>
      ) : (
        <ol className={styles.actions}>
          {pipeline.actions.map((action) => (
            <li data-tone={action.tone} key={action.id}>
              <header>
                <span>
                  <small>{action.stageName}</small>
                  <strong>{action.name}</strong>
                </span>
                <StateLabel label={action.status} tone={action.tone} />
              </header>
              <dl>
                <div>
                  <dt>Provider</dt>
                  <dd>{action.provider}</dd>
                </div>
                <div>
                  <dt>Duration</dt>
                  <dd>{action.duration}</dd>
                </div>
                <div>
                  <dt>Actor</dt>
                  <dd>{action.actor ?? "Not synchronized"}</dd>
                </div>
                <div>
                  <dt>Region</dt>
                  <dd>{action.region ?? "Not synchronized"}</dd>
                </div>
              </dl>
              {action.summary === null ? null : <p>{action.summary}</p>}
              {action.error === null ? null : <p className={styles.error}>{action.error}</p>}
              {action.artifacts.length === 0 ? null : (
                <ul className={styles.artifacts}>
                  {action.artifacts.map((artifact, index) => (
                    <li key={`${artifact.direction}-${artifact.name}-${String(index)}`}>
                      <span>{artifact.direction}</span>
                      <strong>{artifact.name}</strong>
                      <small>{artifact.accessLabel}</small>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </Section>

    <Section heading="Source artifacts" meta="Metadata only; content stays behind the authenticated proxy">
      {pipeline.sourceArtifacts.length === 0 ? (
        <Text tone="secondary">No source artifact metadata was synchronized.</Text>
      ) : (
        <ul className={styles.sourceArtifacts}>
          {pipeline.sourceArtifacts.map((artifact) => (
            <li key={`${artifact.name}-${artifact.revision}`}>
              <span>
                <strong>{artifact.name}</strong>
                <code>{artifact.revision}</code>
              </span>
              <span>
                {artifact.summary ?? "No summary"}
                <small>{artifact.accessLabel}</small>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>

    <Section heading="Delivery evidence" meta="Current accepted relationships around this exact run">
      <dl className={styles.deliveryCounts}>
        <div>
          <dt>Releases</dt>
          <dd>{pipeline.releaseCountLabel}</dd>
        </div>
        <div>
          <dt>Pull requests</dt>
          <dd>{pipeline.pullRequestCountLabel}</dd>
        </div>
        <div>
          <dt>Runbooks</dt>
          <dd>{pipeline.runbookCountLabel}</dd>
        </div>
      </dl>
      <Text tone="secondary">
        Use the delivery relationships below to open each connected object and inspect its evidence.
      </Text>
    </Section>
  </article>
)
