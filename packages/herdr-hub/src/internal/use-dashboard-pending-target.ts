import { useEffect, useState } from "react"
import type { DashboardSnapshot, PendingApprovalTarget } from "../dashboard-model.js"
import type { ApprovalNotificationCandidate } from "../model.js"
import { dashboardHasPendingApprovalTarget, type PendingApprovalTargetRevalidation } from "./dashboard-pending-state.js"

export interface PendingTargetCheck extends ApprovalNotificationCandidate {
  readonly state: "checking" | "failed" | "missing"
}

interface DashboardPendingTargetView {
  readonly target: PendingApprovalTarget | null
  readonly check: PendingTargetCheck | null
}

interface TargetRead {
  readonly snapshot: DashboardSnapshot
  readonly link: ApprovalNotificationCandidate
  readonly result: PendingApprovalTargetRevalidation
}

/** A target outside page one must answer for this exact snapshot before it can authorize a decision. */
export const useDashboardPendingTarget = (
  snapshot: DashboardSnapshot,
  link: ApprovalNotificationCandidate | null,
  load: (link: ApprovalNotificationCandidate) => Promise<PendingApprovalTargetRevalidation>
): DashboardPendingTargetView => {
  const [read, setRead] = useState<TargetRead | null>(null)
  const host = link?.host
  const jobId = link?.jobId
  const listed = link !== null && dashboardHasPendingApprovalTarget(snapshot, link)
  useEffect(() => {
    if (host === undefined || jobId === undefined || listed) return
    let current = true
    const target = { host, jobId }
    void load(target).then((result) => {
      if (current) setRead({ snapshot, link: target, result })
    })
    return () => {
      current = false
    }
  }, [snapshot, host, jobId, listed, load])
  if (link === null || listed) return { target: null, check: null }
  if (read === null || read.snapshot !== snapshot || read.link.host !== link.host || read.link.jobId !== link.jobId) {
    return { target: null, check: { ...link, state: "checking" } }
  }
  if (read.result._tag === "Found") return { target: read.result.target, check: null }
  return { target: null, check: { ...link, state: read.result._tag === "Retry" ? "failed" : "missing" } }
}
