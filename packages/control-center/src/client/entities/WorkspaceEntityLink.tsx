import type { RlyLinkProps } from "@knpkv/rly/foundations"
import { forwardRef, type ReactElement } from "react"
import { Link, useLocation } from "react-router"

import {
  entityOriginFromLocation,
  makeWorkspaceEntityRouteState,
  workspaceEntityTargetFromHref
} from "../items/workspaceEntityRoutes.js"
import {
  rememberWorkspaceScrollPosition,
  shouldRememberWorkspaceScrollPosition
} from "../workspaceScrollRestoration.js"

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
    ? undefined
    : makeWorkspaceEntityRouteState(
        location.state,
        target.workspaceId,
        target.entityId,
        entityOriginFromLocation(location)
      )
}

/** React Router bridge installed only inside lazy entity-aware route chunks. */
export const WorkspaceEntityLink = forwardRef<HTMLAnchorElement, RlyLinkProps>(function WorkspaceEntityLink(
  { href, onClick, ...props },
  ref
): ReactElement {
  const location = useLocation()
  const state = workspaceEntityStateForHref(href, location)
  return (
    <Link
      {...props}
      onClick={(event) => {
        onClick?.(event)
        if (state !== undefined && shouldRememberWorkspaceScrollPosition(event, event.currentTarget.target)) {
          rememberWorkspaceScrollPosition(location)
        }
      }}
      ref={ref}
      state={state}
      to={href}
    />
  )
})
