import { type ComponentPropsWithRef, type ReactElement, useId } from "react"
import { RlyLink } from "../foundations/LinkProvider.js"
import { classNames, cssClass, requireText } from "../internal/component.js"
import { StateLabel, type RlyStateTone } from "../primitives/StateLabel.js"
import { Person, type RlyPerson } from "./Person.js"
import { ServiceMark, RLY_SERVICE_MARK_VARIANTS, type RlyService } from "./ServiceMark.js"
import { type RlyStage, StageRail } from "./StageRail.js"
import styles from "./WorksetCard.module.css"

const style = (name: string): string => cssClass(styles, name)

/** One presenter-owned Jira work item. */
export interface RlyWorksetJiraItem {
  readonly id: string
  readonly key: string
  readonly title: string
  readonly state: string
  readonly tone: RlyStateTone
  readonly href?: string
  readonly owner?: RlyPerson
}

/** One presenter-owned pull-request grouping with every linked Jira key supplied explicitly. */
export interface RlyWorksetPullRequestGroup {
  readonly id: string
  readonly title: string
  readonly reference: string
  readonly state: string
  readonly tone: RlyStateTone
  readonly href?: string
  readonly linkedJiraKeys: ReadonlyArray<string>
  readonly author?: RlyPerson
}

/** An explicit missing relationship; WorksetCard never invents gaps from other arrays. */
export interface RlyWorksetGap {
  readonly id: string
  readonly label: string
  readonly reason: string
  readonly service: RlyService
}

/** One presenter-owned pipeline execution and its complete ordered stage projection. */
export interface RlyWorksetPipeline {
  readonly id: string
  readonly title: string
  readonly reference: string
  readonly state: string
  readonly tone: RlyStateTone
  readonly href?: string
  readonly stages: ReadonlyArray<RlyStage>
  readonly operator?: RlyPerson
  readonly approver?: RlyPerson
}

/** Presentation-only release work dimensions supplied in application-defined order. */
export type WorksetCardProps = Omit<ComponentPropsWithRef<"section">, "aria-label" | "children"> & {
  readonly heading: string
  readonly jiraItems: ReadonlyArray<RlyWorksetJiraItem>
  readonly pullRequestGroups: ReadonlyArray<RlyWorksetPullRequestGroup>
  readonly gaps: ReadonlyArray<RlyWorksetGap>
  readonly pipelines: ReadonlyArray<RlyWorksetPipeline>
  readonly jiraEmptyLabel?: string
  readonly pullRequestEmptyLabel?: string
  readonly gapEmptyLabel?: string
  readonly pipelineEmptyLabel?: string
}

const validateHref = (href: string | undefined, context: string): void => {
  if (href !== undefined) requireText(href, `${context} href`)
}

const validateUniqueId = (id: string, ids: Set<string>, context: string): string => {
  const visibleId = requireText(id, `${context} id`)
  if (ids.has(visibleId)) throw new Error(`${context} ids must be unique: ${visibleId}`)
  ids.add(visibleId)
  return visibleId
}

const validateJiraItems = (items: ReadonlyArray<RlyWorksetJiraItem>): void => {
  const ids = new Set<string>()
  for (const item of items) {
    const id = validateUniqueId(item.id, ids, "WorksetCard Jira item")
    requireText(item.key, `WorksetCard Jira key for ${id}`)
    requireText(item.title, `WorksetCard Jira title for ${id}`)
    requireText(item.state, `WorksetCard Jira state for ${id}`)
    validateHref(item.href, `WorksetCard Jira item ${id}`)
  }
}

const validatePullRequestGroups = (groups: ReadonlyArray<RlyWorksetPullRequestGroup>): void => {
  const ids = new Set<string>()
  for (const group of groups) {
    const id = validateUniqueId(group.id, ids, "WorksetCard pull request group")
    requireText(group.title, `WorksetCard pull request title for ${id}`)
    requireText(group.reference, `WorksetCard pull request reference for ${id}`)
    requireText(group.state, `WorksetCard pull request state for ${id}`)
    validateHref(group.href, `WorksetCard pull request group ${id}`)
    for (const key of group.linkedJiraKeys) requireText(key, `WorksetCard linked Jira key for ${id}`)
  }
}

const validateGaps = (gaps: ReadonlyArray<RlyWorksetGap>): void => {
  const ids = new Set<string>()
  for (const gap of gaps) {
    const id = validateUniqueId(gap.id, ids, "WorksetCard gap")
    requireText(gap.label, `WorksetCard gap label for ${id}`)
    requireText(gap.reason, `WorksetCard gap reason for ${id}`)
    if (!Object.hasOwn(RLY_SERVICE_MARK_VARIANTS.service, gap.service)) {
      throw new Error(`WorksetCard gap service for ${id} must be supported`)
    }
  }
}

const validatePipelines = (pipelines: ReadonlyArray<RlyWorksetPipeline>): void => {
  const ids = new Set<string>()
  for (const pipeline of pipelines) {
    const id = validateUniqueId(pipeline.id, ids, "WorksetCard pipeline")
    requireText(pipeline.title, `WorksetCard pipeline title for ${id}`)
    requireText(pipeline.reference, `WorksetCard pipeline reference for ${id}`)
    requireText(pipeline.state, `WorksetCard pipeline state for ${id}`)
    validateHref(pipeline.href, `WorksetCard pipeline ${id}`)
  }
}

interface LinkedIdentityProps {
  readonly href?: string
  readonly reference: string
  readonly title: string
}

const LinkedIdentity = ({ href, reference, title }: LinkedIdentityProps): ReactElement => {
  const identity = (
    <span className={style("identity")}>
      <span className={style("itemTitle")}>{title}</span>
      <span className={style("reference")}>{reference}</span>
    </span>
  )
  return href === undefined ? (
    identity
  ) : (
    <RlyLink className={style("link")} href={href}>
      {identity}
    </RlyLink>
  )
}

/** Render Jira, PR, and pipeline dimensions as one complete release work surface. */
export const WorksetCard = ({
  className,
  gapEmptyLabel = "No relationship gaps recorded.",
  gaps,
  heading,
  jiraEmptyLabel = "No Jira work recorded.",
  jiraItems,
  pipelineEmptyLabel = "No pipeline delivery recorded.",
  pipelines,
  pullRequestEmptyLabel = "No pull request groups recorded.",
  pullRequestGroups,
  ...props
}: WorksetCardProps): ReactElement => {
  const visibleHeading = requireText(heading, "WorksetCard heading")
  const visibleJiraEmpty = requireText(jiraEmptyLabel, "WorksetCard jiraEmptyLabel")
  const visiblePullRequestEmpty = requireText(pullRequestEmptyLabel, "WorksetCard pullRequestEmptyLabel")
  const visibleGapEmpty = requireText(gapEmptyLabel, "WorksetCard gapEmptyLabel")
  const visiblePipelineEmpty = requireText(pipelineEmptyLabel, "WorksetCard pipelineEmptyLabel")
  validateJiraItems(jiraItems)
  validatePullRequestGroups(pullRequestGroups)
  validateGaps(gaps)
  validatePipelines(pipelines)
  const headingId = `rly-workset-${useId()}`

  return (
    <section {...props} aria-labelledby={headingId} className={classNames(style("root"), className)}>
      <h2 className={style("heading")} id={headingId}>
        {visibleHeading}
      </h2>
      <div className={style("dimensions")}>
        <section className={style("dimension")} data-rly-workset-dimension="jira">
          <div className={style("dimensionHeading")}>
            <ServiceMark service="jira" size="compact" />
            <h3>Jira work</h3>
          </div>
          {jiraItems.length === 0 ? (
            <p className={style("empty")}>{visibleJiraEmpty}</p>
          ) : (
            <ul className={style("list")}>
              {jiraItems.map((item) => (
                <li className={style("item")} data-rly-workset-jira-id={item.id} key={item.id}>
                  <LinkedIdentity
                    {...(item.href === undefined ? {} : { href: item.href })}
                    reference={item.key}
                    title={item.title}
                  />
                  <StateLabel label={item.state} size="compact" tone={item.tone} />
                  {item.owner === undefined ? null : <Person person={item.owner} size="compact" />}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={style("dimension")} data-rly-workset-dimension="pull-requests">
          <div className={style("dimensionHeading")}>
            <ServiceMark service="codecommit" size="compact" />
            <h3>Pull request groups</h3>
          </div>
          {pullRequestGroups.length === 0 ? (
            <p className={style("empty")}>{visiblePullRequestEmpty}</p>
          ) : (
            <ul className={style("list")}>
              {pullRequestGroups.map((group) => (
                <li className={style("item")} data-rly-workset-pr-id={group.id} key={group.id}>
                  <LinkedIdentity
                    {...(group.href === undefined ? {} : { href: group.href })}
                    reference={group.reference}
                    title={group.title}
                  />
                  <StateLabel label={group.state} size="compact" tone={group.tone} />
                  <div className={style("linkedWork")}>
                    <span className={style("conceptLabel")}>Linked Jira work</span>
                    {group.linkedJiraKeys.length === 0 ? (
                      <span className={style("emptyLink")}>No Jira links recorded.</span>
                    ) : (
                      <ul className={style("keyList")}>
                        {group.linkedJiraKeys.map((key, index) => (
                          <li data-rly-linked-jira-key={key} key={`${key}-${index}`}>
                            {key}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  {group.author === undefined ? null : <Person person={group.author} size="compact" />}
                </li>
              ))}
            </ul>
          )}

          <div className={style("gaps")}>
            <h4>Relationship gaps</h4>
            {gaps.length === 0 ? (
              <p className={style("empty")}>{visibleGapEmpty}</p>
            ) : (
              <ul className={style("gapList")}>
                {gaps.map((gap) => (
                  <li className={style("gap")} data-rly-workset-gap-id={gap.id} key={gap.id}>
                    <ServiceMark service={gap.service} size="compact" />
                    <strong>{gap.label}</strong>
                    <span>{gap.reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className={style("dimension")} data-rly-workset-dimension="pipelines">
          <div className={style("dimensionHeading")}>
            <ServiceMark service="codepipeline" size="compact" />
            <h3>Pipeline delivery</h3>
          </div>
          {pipelines.length === 0 ? (
            <p className={style("empty")}>{visiblePipelineEmpty}</p>
          ) : (
            <ul className={style("list")}>
              {pipelines.map((pipeline) => (
                <li className={style("item")} data-rly-workset-pipeline-id={pipeline.id} key={pipeline.id}>
                  <LinkedIdentity
                    {...(pipeline.href === undefined ? {} : { href: pipeline.href })}
                    reference={pipeline.reference}
                    title={pipeline.title}
                  />
                  <StateLabel label={pipeline.state} size="compact" tone={pipeline.tone} />
                  {pipeline.operator === undefined ? null : <Person person={pipeline.operator} size="compact" />}
                  {pipeline.approver === undefined ? null : <Person person={pipeline.approver} size="compact" />}
                  <StageRail heading={`${pipeline.reference} stages`} size="compact" stages={pipeline.stages} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </section>
  )
}
