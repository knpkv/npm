import type { ReactElement, ReactNode } from "react"
import { NavLink } from "react-router"

import type { WorkspaceId } from "../../domain/identifiers.js"
import { useWorkspaceDefaultLandingPath } from "./useWorkspaceDefaultLanding.js"

export interface WorkspaceHomeLinkProps {
  readonly children: ReactNode
  readonly className: string
  readonly fallbackPath: string
  readonly workspaceId: WorkspaceId
}

/** Brand navigation that resolves the workspace-owned presentation default lazily. */
export const WorkspaceHomeLink = ({
  children,
  className,
  fallbackPath,
  workspaceId
}: WorkspaceHomeLinkProps): ReactElement => {
  const defaultLandingPath = useWorkspaceDefaultLandingPath(workspaceId)
  return (
    <NavLink className={className} to={defaultLandingPath ?? fallbackPath}>
      {children}
    </NavLink>
  )
}
