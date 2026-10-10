// Fixtures from packages/herdr-hub/test/approval-request.test.tsx.
import { ApprovalRequestDisclosure } from "@knpkv/relay-app-design-system"
import type { ApprovalRequestDisclosureProps } from "@knpkv/herdr-hub/views"
import { useEffect, useRef } from "react"

const delegated = {
  id: "request-pending_approval",
  payload: {
    channel: "coordinator_chat",
    kind: "agent.delegate",
    mode: "work",
    prompt: "[redacted internal prompt]",
    repository: "/srv/npm"
  }
} satisfies ApprovalRequestDisclosureProps

const transition = {
  id: "same-job",
  payload: {
    kind: "agent.delegate",
    mode: "transition_summary",
    prompt: "[redacted internal prompt]",
    repository: "/srv/npm"
  }
} satisfies ApprovalRequestDisclosureProps

/** Opens the component's own disclosure after mount, keeping its native contents and behavior. */
const OpenDisclosure = (props: ApprovalRequestDisclosureProps) => {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const details = host.current?.querySelector("details")
    if (details !== undefined && details !== null) details.open = true
  }, [])
  return (
    <div ref={host}>
      <ApprovalRequestDisclosure {...props} />
    </div>
  )
}

export const Default = () => <ApprovalRequestDisclosure {...delegated} />
export const Payload = () => <OpenDisclosure {...delegated} />
export const TransitionSummary = () => <OpenDisclosure {...transition} />
