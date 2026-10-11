import type { JobPayload } from "@knpkv/herdr-fleet/model"
import { useId, type ReactElement } from "react"
import { approvalRequestFor, type ApprovalRequest } from "./approval-request.js"

export type ApprovalRequestDisclosureProps = {
  readonly id: string
  readonly summary?: string
  readonly consequence?: string
  /** Defaults to fields. JSON contains kind and the same normalized string fields, never raw payload data. */
  readonly format?: "fields" | "json"
} & ({ readonly payload: JobPayload } | { readonly request: ApprovalRequest })

export const ApprovalRequestDisclosure = (props: ApprovalRequestDisclosureProps): ReactElement => {
  const request = "request" in props ? props.request : approvalRequestFor(props.payload)
  const instanceId = useId()
  const detailId = `approval-request-${encodeURIComponent(props.id)}-${encodeURIComponent(instanceId)}`
  return (
    <details className="approval-request-disclosure">
      <summary aria-controls={detailId}>{props.summary ?? "View full request"}</summary>
      <div className="approval-request-detail" id={detailId} role="region" aria-label={`${request.title} request`}>
        {props.format === "json" ? (
          <h4 className="approval-request-title">{request.title}</h4>
        ) : (
          <p className="approval-request-kind">{request.kind}</p>
        )}
        {props.consequence === undefined ? null : <p className="approval-request-consequence">{props.consequence}</p>}
        {props.format === "json" ? (
          <pre className="approval-request-json">
            <code>
              {JSON.stringify(
                {
                  kind: request.kind,
                  ...Object.fromEntries(request.fields.map(({ key, value }) => [key, value]))
                },
                null,
                2
              )}
            </code>
          </pre>
        ) : request.fields.length === 0 ? (
          <p>No additional fields.</p>
        ) : (
          <dl>
            {request.fields.map((item) => (
              <div data-approval-field={item.key} key={item.key}>
                <dt>{item.label}</dt>
                <dd data-redacted={item.redacted ? "true" : undefined}>{item.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </details>
  )
}
