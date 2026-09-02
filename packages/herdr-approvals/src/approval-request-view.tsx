import type { JobPayload } from "@knpkv/herdr-fleet/model"
import type { ReactElement } from "react"
import { approvalRequestFor, type ApprovalRequest } from "./approval-request.js"

type ApprovalRequestDisclosureProps = {
  readonly id: string
} & ({ readonly payload: JobPayload } | { readonly request: ApprovalRequest })

export const ApprovalRequestDisclosure = (props: ApprovalRequestDisclosureProps): ReactElement => {
  const request = "request" in props ? props.request : approvalRequestFor(props.payload)
  const detailId = `approval-request-${encodeURIComponent(props.id)}`
  return (
    <details className="approval-request-disclosure">
      <summary aria-controls={detailId}>View full request</summary>
      <div className="approval-request-detail" id={detailId} role="region" aria-label={`${request.title} request`}>
        <p className="approval-request-kind">{request.kind}</p>
        {request.fields.length === 0 ? (
          <p>No additional fields.</p>
        ) : (
          <dl>
            {request.fields.map((item) => (
              <div key={item.key}>
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
