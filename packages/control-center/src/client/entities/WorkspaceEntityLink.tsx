import type { RlyLinkProps } from "@knpkv/rly/foundations"
import { forwardRef, type ReactElement } from "react"
import { Link, useLocation } from "react-router"

import {
  entityOriginFromLocation,
  makeWorkspaceEntityRouteState,
  workspaceEntityTargetFromHref
} from "../items/workspaceEntityRoutes.js"

interface RouterLocationParts {
  readonly hash: string
  readonly pathname: string
  readonly search: string
  readonly state: unknown
}

/** Preserve the validated root origin when an Rly relationship opens another canonical entity. */
export const workspaceEntityStateForHref = (href: string, location: RouterLocationParts): unknown => {
  const target = workspaceEntityTargetFromHref(href)
  return target === null
    ? location.state
    : makeWorkspaceEntityRouteState(
        location.state,
        target.workspaceId,
        target.entityId,
        entityOriginFromLocation(location)
      )
}

/** React Router bridge installed only inside lazy entity-aware route chunks. */
export const WorkspaceEntityLink = forwardRef<HTMLAnchorElement, RlyLinkProps>(function WorkspaceEntityLink(
  { href, ...props },
  ref
): ReactElement {
  const location = useLocation()
  return <Link {...props} ref={ref} state={workspaceEntityStateForHref(href, location)} to={href} />
})
