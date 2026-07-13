import { useId, type ComponentPropsWithRef, type ReactElement } from "react"
import { Icon } from "../foundations/Icon.js"
import { RlyLink } from "../foundations/LinkProvider.js"
import { classNames, cssClass, requireText } from "../internal/component.js"
import { StateLabel } from "../primitives/StateLabel.js"
import { Person } from "./Person.js"
import {
  RLY_RELATIONSHIP_DIRECTION_PRESENTATION,
  RLY_RELATIONSHIP_LIFECYCLE_PRESENTATION,
  type RlyRelationship,
  type RlyRelationshipEndpoint,
  validateRelationships
} from "./Relationship.js"
import { ServiceMark } from "./ServiceMark.js"
import styles from "./RelationshipTable.module.css"

const style = (name: string): string => cssClass(styles, name)

/** Props semantically equivalent to RelationshipChain. */
export type RelationshipTableProps = Omit<ComponentPropsWithRef<"section">, "aria-label" | "children"> & {
  readonly relationships: ReadonlyArray<RlyRelationship>
  readonly heading: string
  readonly emptyLabel?: string
}

interface EndpointProps {
  readonly endpoint: RlyRelationshipEndpoint
}

const Endpoint = ({ endpoint }: EndpointProps): ReactElement => {
  if (endpoint.state === "missing") {
    return (
      <div className={classNames(style("endpoint"), style("missingEndpoint"))} data-rly-endpoint-state="missing">
        {endpoint.service === undefined ? null : <ServiceMark service={endpoint.service} size="compact" />}
        <span className={style("identity")}>
          <span className={style("missingLabel")}>
            <Icon decorative name="alert" size="small" />
            {endpoint.label}
          </span>
          <span className={style("reference")}>{endpoint.reason}</span>
        </span>
      </div>
    )
  }

  const identity = (
    <span className={style("identity")}>
      <span className={style("title")}>{endpoint.title}</span>
      <span className={style("reference")}>{endpoint.reference}</span>
    </span>
  )

  return (
    <div className={style("endpoint")} data-rly-endpoint-id={endpoint.id} data-rly-endpoint-state="present">
      <ServiceMark service={endpoint.service} size="compact" />
      {endpoint.href === undefined ? (
        identity
      ) : (
        <RlyLink className={style("endpointLink")} href={endpoint.href}>
          {identity}
        </RlyLink>
      )}
      {endpoint.person === undefined ? null : <Person person={endpoint.person} size="compact" />}
    </div>
  )
}

/** Render the same ordered records as RelationshipChain in a scan-friendly native table. */
export const RelationshipTable = ({
  className,
  emptyLabel = "No relationships recorded.",
  heading,
  relationships,
  ...props
}: RelationshipTableProps): ReactElement => {
  const visibleHeading = requireText(heading, "RelationshipTable heading")
  const visibleEmptyLabel = requireText(emptyLabel, "RelationshipTable emptyLabel")
  validateRelationships(relationships)
  const headingId = `${useId()}-heading`

  return (
    <section {...props} aria-labelledby={headingId} className={classNames(style("root"), className)}>
      <h2 className={style("heading")} id={headingId}>
        {visibleHeading}
      </h2>
      {relationships.length === 0 ? (
        <p className={style("empty")}>{visibleEmptyLabel}</p>
      ) : (
        <table aria-labelledby={headingId} className={style("table")}>
          <thead className={style("head")}>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Relationship</th>
              <th scope="col">Target</th>
              <th scope="col">Evidence</th>
            </tr>
          </thead>
          <tbody className={style("body")}>
            {relationships.map((relationship) => {
              const direction = RLY_RELATIONSHIP_DIRECTION_PRESENTATION[relationship.direction]
              const lifecycle = RLY_RELATIONSHIP_LIFECYCLE_PRESENTATION[relationship.lifecycle]
              return (
                <tr
                  className={style("row")}
                  data-rly-relationship-id={relationship.id}
                  data-rly-relationship-direction={relationship.direction}
                  data-rly-relationship-kind={relationship.kind}
                  data-rly-relationship-lifecycle={relationship.lifecycle}
                  key={relationship.id}
                >
                  <td className={style("cell")} data-label="Source">
                    <Endpoint endpoint={relationship.source} />
                  </td>
                  <td className={style("cell")} data-label="Relationship">
                    <div className={style("relationship")} data-rly-relationship-detail="">
                      <span className={style("direction")}>
                        <span>{direction.label}</span>
                        <span aria-hidden="true" className={style("arrow")}>
                          {direction.arrow}
                        </span>
                      </span>
                      <span className={style("kind")}>{relationship.kind}</span>
                      <StateLabel icon={lifecycle.icon} label={lifecycle.label} size="compact" tone="neutral" />
                      {relationship.actor === undefined ? null : (
                        <div className={style("actor")} data-rly-relationship-actor={relationship.actor.id}>
                          <span className={style("fieldLabel")}>Actor</span>
                          <Person person={relationship.actor} size="compact" />
                        </div>
                      )}
                    </div>
                  </td>
                  <td className={style("cell")} data-label="Target">
                    <Endpoint endpoint={relationship.target} />
                  </td>
                  <td className={style("cell")} data-label="Evidence">
                    <span className={style("evidence")} data-rly-relationship-evidence="">
                      {relationship.evidence ?? "No evidence recorded."}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}
