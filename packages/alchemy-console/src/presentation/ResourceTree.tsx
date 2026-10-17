import { Icon } from "@knpkv/rly/foundations"
import { Text } from "@knpkv/rly/primitives"
import { useId, useState, type ReactElement } from "react"
import type { ResourcePresentation } from "./detail-model.js"

interface Construct {
  readonly parent: string | null
  readonly resources: Array<ResourcePresentation>
  readonly types: Map<string, Array<ResourcePresentation>>
}

/** Group by the returned construct identity and exact type. Missing parents never become invented resource identities. */
export const groupResourceTree = (resources: ReadonlyArray<ResourcePresentation>): ReadonlyArray<Construct> => {
  const constructs = new Map<string | null, Construct>()
  for (const resource of resources) {
    let construct = constructs.get(resource.parent)
    if (construct === undefined) {
      construct = { parent: resource.parent, resources: [], types: new Map() }
      constructs.set(resource.parent, construct)
    }
    construct.resources.push(resource)
    const type = construct.types.get(resource.resourceType)
    if (type === undefined) construct.types.set(resource.resourceType, [resource])
    else type.push(resource)
  }
  return [...constructs.values()]
}

/** Full-width construct → type → resource disclosure tree. Only actual returned resources have navigation destinations. */
export const ResourceTree = ({
  app,
  resourceHref,
  resources,
  stage
}: {
  readonly app: string
  readonly stage: string
  readonly resources: ReadonlyArray<ResourcePresentation>
  /** Each resource's page; null when the host has none, and names render as plain text. */
  readonly resourceHref: ((resource: ResourcePresentation) => string) | null
}): ReactElement => {
  const headingId = useId()
  const constructs = groupResourceTree(resources)
  return (
    <section className="ac-detail-section" aria-labelledby={headingId}>
      <div className="ac-detail-section-heading">
        <Text as="h2" variant="section-title" id={headingId}>
          Resources
        </Text>
        <Text variant="meta" tone="secondary">
          {resources.length} {resources.length === 1 ? "resource" : "resources"}
          {constructs.length === 0
            ? ""
            : `, ${constructs.filter((construct) => construct.parent !== null).length} constructs`}
        </Text>
      </div>
      {resources.length === 0 ? (
        <div className="ac-detail-panel ac-empty-state">
          <span className="ac-empty-state-creature" aria-hidden="true" />
          <div className="ac-empty-state-copy">
            <Text as="p" className="ac-detail-panel-title">
              No resources in state
            </Text>
            <Text as="p" tone="secondary">
              {app} / {stage} has state but records no resources. Nothing has been created yet, or everything was
              removed in an earlier deployment.
            </Text>
          </div>
        </div>
      ) : (
        <div className="ac-resource-tree">
          {constructs.map((construct, index) => (
            <ConstructGroup
              key={construct.parent ?? ""}
              construct={construct}
              initiallyOpen={index === 0 || (constructs.length > 2 && index === 1)}
              resourceHref={resourceHref}
            />
          ))}
        </div>
      )}
    </section>
  )
}

const ConstructGroup = ({
  construct,
  initiallyOpen,
  resourceHref
}: {
  readonly construct: Construct
  readonly initiallyOpen: boolean
  /** Each resource's page; null when the host has none, and names render as plain text. */
  readonly resourceHref: ((resource: ResourcePresentation) => string) | null
}): ReactElement => {
  const [open, setOpen] = useState(initiallyOpen)
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="ac-construct">
      <summary>
        <Icon name={open ? "chevron-down" : "chevron-right"} decorative size="small" />
        <span className="ac-construct-name">{construct.parent ?? "No construct"}</span>
        <span className="ac-construct-count">
          {construct.resources.length} {construct.resources.length === 1 ? "resource" : "resources"}
        </span>
      </summary>
      <div className="ac-construct-types">
        {[...construct.types].map(([type, rows]) => (
          <section className="ac-type-group" key={type} aria-label={type}>
            <div className="ac-tree-type">
              {type} <span>{rows.length}</span>
            </div>
            <ul>
              {rows.map((resource) => (
                <li key={resource.fqn}>
                  {resourceHref === null ? (
                    <span className="ac-tree-resource">
                      <span>{resource.logicalId}</span>
                    </span>
                  ) : (
                    <a href={resourceHref(resource)} className="ac-tree-resource ac-detail-link">
                      <span>{resource.logicalId}</span>
                      <Icon name="chevron-right" decorative size="small" />
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </details>
  )
}
