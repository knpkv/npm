import { Result } from "effect"
import { useEffect } from "react"
import type { PendingApprovalTarget } from "../dashboard-model.js"
import { matchesApprovalDeepLink, readApprovalDeepLink } from "../pwa.js"

/** Select the exact approval after URL or snapshot changes, including a module handoff. */
export const useApprovalTargetFocus = (
  search: string,
  observedAt: number,
  target: PendingApprovalTarget | null
): void => {
  useEffect(() => {
    const decoded = readApprovalDeepLink(search)
    if (Result.isFailure(decoded) || decoded.success === null) return
    const item = [...document.querySelectorAll<HTMLElement>("[data-agenda-item]")].find((item) =>
      matchesApprovalDeepLink(item.dataset, decoded.success)
    )
    if (item === undefined) return
    item.dataset.approvalTarget = "true"
    item.focus({ preventScroll: true })
    item.scrollIntoView({ behavior: "smooth", block: "center" })
    return () => item.removeAttribute("data-approval-target")
  }, [observedAt, search, target])
}
