import { Text } from "@knpkv/rly/primitives"
import { useMemo, type ReactElement } from "react"
import type { StackListCopy } from "./StackListView.js"
import type { ResourcePresentation, StackPresentation } from "./detail-model.js"
import { DetailPanel, Missing, ProviderLink, RecordedTime, ResourceStatus } from "./detail-parts.js"
import { indexDependencies } from "./resource-graph.js"

export interface ResourceDetailViewProps {
  readonly stack: StackPresentation
  readonly resource: ResourcePresentation
  readonly copy: StackListCopy
  readonly stackHref: string
  readonly resourceHref: (resource: ResourcePresentation) => string
}

/** Resource-own metadata only, with dependencies inverted from the complete returned stack. No properties or provider calls. */
export const ResourceDetailView = ({
  copy,
  resource,
  resourceHref,
  stack,
  stackHref
}: ResourceDetailViewProps): ReactElement => {
  const graph = useMemo(() => indexDependencies(stack.resources), [stack.resources])
  const dependencies = graph?.get(resource.fqn) ?? null
  return (
    <div className="ac-detail ac-resource-detail">
      <a data-rly-hit-area className="ac-detail-link ac-resource-back" href={stackHref}>
        ← {stack.app} {stack.stage}
      </a>
      <header className="ac-detail-header">
        <Text as="h1" variant="page-title" className="ac-title">
          {resource.logicalId}
        </Text>
        <Text as="p" tone="secondary">
          {resource.resourceType}
        </Text>
      </header>
      <div className="ac-resource-identity">
        <dl className="ac-identity-table">
          <div>
            <dt>Logical name</dt>
            <dd>{resource.logicalId}</dd>
          </div>
          <div>
            <dt>Type</dt>
            <dd className="ac-resource-id">{resource.resourceType}</dd>
          </div>
          <div>
            <dt>Physical ID</dt>
            <dd className="ac-resource-id">{resource.providerId ?? <Missing />}</dd>
          </div>
          <div>
            <dt>Region</dt>
            <dd>{resource.region ?? <Missing />}</dd>
          </div>
          <div>
            <dt>Account</dt>
            <dd className="ac-resource-id">{resource.account ?? <Missing />}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>
              <ResourceStatus status={resource.status} />
            </dd>
          </div>
          <div>
            <dt>Last updated</dt>
            <dd>
              <RecordedTime value={resource.updatedAt} />
            </dd>
          </div>
          <div>
            <dt>Construct</dt>
            <dd>{resource.parent ?? <Missing />}</dd>
          </div>
        </dl>
        <Text as="p" variant="meta" tone="secondary">
          Identity comes from this resource’s own state and is shown only to the signed-in owner.
        </Text>
        <ProviderLink resource={resource} />
      </div>
      {dependencies !== null && dependencies.length > 0 ? (
        <section className="ac-detail-section">
          <Text as="h2" variant="section-title">
            Dependencies
          </Text>
          <ul className="ac-dependencies">
            {dependencies.map((dependency) => (
              <li key={dependency.fqn}>
                <a data-rly-hit-area className="ac-detail-link ac-resource-name" href={resourceHref(dependency)}>
                  {dependency.logicalId}
                </a>
                <span className="ac-resource-type">{dependency.resourceType}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="ac-detail-section">
        <Text as="h2" variant="section-title">
          Properties
        </Text>
        <DetailPanel title="Not available yet">
          {copy.product} shows resource identity only for now. Properties come later.
        </DetailPanel>
      </section>
    </div>
  )
}
