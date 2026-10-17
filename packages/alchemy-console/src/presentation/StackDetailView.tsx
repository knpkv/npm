import { Tabs, Text } from "@knpkv/rly/primitives"
import { useId, type ReactElement } from "react"
import type { PlanState } from "../plan.js"
import { PlanView } from "./PlanView.js"
import type { StackListCopy } from "./StackListView.js"
import type { ResourcePresentation, StackDetailState, StackPresentation, StackTab } from "./detail-model.js"
import { DetailBoundary, DetailPanel, Missing, ProviderLink, RecordedTime, ResourceStatus } from "./detail-parts.js"
import { ResourceTree } from "./ResourceTree.js"

export interface StackDetailViewProps {
  readonly state: StackDetailState
  readonly planState?: PlanState
  readonly onReadPlanAgain?: () => void
  readonly copy: StackListCopy
  readonly tab: StackTab
  readonly onTabChange: (tab: StackTab) => void
  readonly onReadAgain: () => void
  /** The mounting application's real resource detail destination, using normalized owner-visible identity. */
  readonly resourceHref: (resource: ResourcePresentation) => string
}

const Label = ({ children }: { readonly children: string }): ReactElement => (
  <span className="ac-detail-mobile-label" aria-hidden="true">
    {children}
  </span>
)

/** One stack's resource table: logical name, type, physical ID, status and last update. */
export const StackResourcesView = ({
  resourceHref,
  stack
}: {
  readonly stack: StackPresentation
  /** Each resource's page; null when the host has none, and names render as plain text. */
  readonly resourceHref: StackDetailViewProps["resourceHref"] | null
}): ReactElement => {
  const headingId = useId()
  const failed = stack.resources.filter((resource) => resource.status === "failed").length
  const unknown = stack.resources.filter((resource) => resource.status === null).length
  return (
    <section className="ac-detail-section" aria-labelledby={headingId}>
      <div className="ac-detail-section-heading">
        <Text as="h2" variant="section-title" id={headingId}>
          Resources
        </Text>
        {stack.resources.length > 0 ? (
          <Text variant="meta" tone="secondary">
            {stack.resources.length} {stack.resources.length === 1 ? "resource" : "resources"}
            {failed > 0 ? `, ${failed} failed` : ""}
            {unknown > 0 ? `, ${unknown} Unknown` : ""}
          </Text>
        ) : null}
      </div>
      {stack.resources.length === 0 ? (
        <DetailPanel title="No resources in this stack’s state.">
          Resources appear here once a deployment records them.
        </DetailPanel>
      ) : (
        <div className="ac-detail-table-wrap">
          <table className="ac-detail-table ac-resource-table" aria-labelledby={headingId}>
            <thead>
              <tr>
                <th scope="col">Logical name</th>
                <th scope="col">Type</th>
                <th scope="col">Physical ID</th>
                <th scope="col">Status</th>
                <th scope="col">Last updated</th>
                <th scope="col">
                  <span className="ac-sr-only">Provider console</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {stack.resources.map((resource) => (
                <tr key={resource.fqn}>
                  <th scope="row">
                    <Label>Logical name</Label>
                    {resourceHref === null ? (
                      <span className="ac-resource-name">{resource.logicalId}</span>
                    ) : (
                      <a data-rly-hit-area className="ac-detail-link ac-resource-name" href={resourceHref(resource)}>
                        {resource.logicalId}
                      </a>
                    )}
                  </th>
                  <td className="ac-resource-type">
                    <Label>Type</Label>
                    {resource.resourceType}
                  </td>
                  <td className="ac-resource-id">
                    <Label>Physical ID</Label>
                    {resource.providerId ?? <Missing />}
                  </td>
                  <td className="ac-resource-status-cell">
                    <Label>Status</Label>
                    <ResourceStatus status={resource.status} />
                  </td>
                  <td className="ac-resource-time">
                    <Label>Last updated</Label>
                    <RecordedTime value={resource.updatedAt} />
                  </td>
                  <td className="ac-resource-console">
                    <ProviderLink resource={resource} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/** One stack's outputs: keys only, values Hidden unless explicitly safe; null means unavailable. */
export const StackOutputsView = ({ outputs }: { readonly outputs: StackPresentation["outputs"] }): ReactElement => {
  const headingId = useId()
  const hidden = outputs?.filter((output) => output.value._tag === "Hidden").length ?? 0
  return (
    <section className="ac-detail-section" aria-labelledby={headingId}>
      <div className="ac-detail-section-heading">
        <Text as="h2" variant="section-title" id={headingId}>
          Outputs
        </Text>
        {outputs !== null && outputs.length > 0 ? (
          <Text variant="meta" tone="secondary">
            {outputs.length} {outputs.length === 1 ? "output" : "outputs"}, {hidden} hidden
          </Text>
        ) : null}
      </div>
      {outputs === null ? (
        <DetailPanel title="Not available yet" unavailable>
          The outputs in this stack’s state can’t be read yet.
        </DetailPanel>
      ) : outputs.length === 0 ? (
        <DetailPanel title="This stack has no outputs." />
      ) : (
        <div className="ac-detail-table-wrap">
          <table className="ac-detail-table ac-output-table" aria-labelledby={headingId}>
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">Value</th>
                <th scope="col">Description</th>
              </tr>
            </thead>
            <tbody>
              {outputs.map((output) => (
                <tr key={output.key}>
                  <th scope="row">
                    <Label>Key</Label>
                    <span className="ac-output-key">{output.key}</span>
                  </th>
                  <td>
                    <Label>Value</Label>
                    {output.value._tag === "Hidden" ? (
                      <span className="ac-detail-muted">Hidden</span>
                    ) : (
                      <span className="ac-output-value">{output.value.text}</span>
                    )}
                  </td>
                  <td className="ac-detail-muted">
                    <Label>Description</Label>
                    {output.description ?? <Missing />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/** Controlled read-only module. The caller owns reads, owner identity, navigation and output safety proof. */
export const StackDetailView = ({
  copy,
  onReadAgain,
  onReadPlanAgain,
  onTabChange,
  planState = { _tag: "NotConnected" },
  resourceHref,
  state,
  tab
}: StackDetailViewProps): ReactElement => {
  if (state._tag !== "Ready")
    return (
      <div className="ac-detail">
        <DetailBoundary state={state} copy={copy} onReadAgain={onReadAgain} />
      </div>
    )
  const stack = state.stack
  return (
    <div className="ac-detail" data-plan={tab === "plan" ? "true" : undefined}>
      <header className="ac-detail-header">
        <div className="ac-detail-title-row">
          <Text as="h1" variant="page-title" className="ac-title">
            {stack.app}
          </Text>
          <span className="ac-stage-badge">{stack.stage}</span>
        </div>
        <Text as="p" tone="secondary" className="ac-description">
          Infrastructure state. Read-only.
        </Text>
      </header>
      <dl className="ac-stack-metadata">
        <div>
          <dt>Region</dt>
          <dd>Unknown</dd>
        </div>
        <div>
          <dt>Backend</dt>
          <dd>{stack.backend === "s3" ? "State bucket" : "Local"}</dd>
        </div>
        <div>
          <dt>Alchemy version</dt>
          <dd className="ac-resource-id">{stack.alchemyVersion ?? "Unknown"}</dd>
        </div>
        <div>
          <dt>Last deploy</dt>
          <dd>{stack.lastDeploy === null ? "Unknown" : <RecordedTime value={stack.lastDeploy} />}</dd>
        </div>
      </dl>
      <Tabs
        className="ac-detail-tabs"
        aria-label="Stack state"
        size="large"
        value={tab}
        data-mobile-layout="single-row"
        onValueChange={(value) => {
          if (value === "resources" || value === "outputs" || value === "state" || value === "plan") onTabChange(value)
        }}
        items={[
          {
            value: "resources",
            label: "Resources",
            content: <StackResourcesView stack={stack} resourceHref={resourceHref} />
          },
          { value: "outputs", label: "Outputs", content: <StackOutputsView outputs={stack.outputs} /> },
          {
            value: "state",
            label: "State",
            content: (
              <ResourceTree
                app={stack.app}
                stage={stack.stage}
                resources={stack.resources}
                resourceHref={resourceHref}
              />
            )
          },
          {
            value: "plan",
            label: "Plan",
            content: <PlanView state={planState} onReadAgain={onReadPlanAgain ?? onReadAgain} />
          }
        ]}
      />
    </div>
  )
}
