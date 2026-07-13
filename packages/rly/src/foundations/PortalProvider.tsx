import { createContext, type ReactElement, type ReactNode, useContext, useState } from "react"

/** A controlled browser portal target supported by React and Radix portals. */
export type RlyPortalContainer = Element | DocumentFragment

export interface PortalProviderProps {
  readonly children: ReactNode
  readonly container?: RlyPortalContainer | null
}

export type RlyPortalTarget =
  { readonly available: false } | { readonly available: true; readonly container: RlyPortalContainer }

interface PortalBoundaryProps {
  readonly children: (container: RlyPortalContainer) => ReactElement
}

const unavailableTarget: RlyPortalTarget = { available: false }
const PortalTargetContext = createContext<RlyPortalTarget>(unavailableTarget)

/** Internal target state for rly overlays. Consumers must prove availability before obtaining a container. */
export const usePortalTarget = (): RlyPortalTarget => useContext(PortalTargetContext)

/** Prevents portal implementations from mounting while their controlled target is unavailable. */
export const PortalBoundary = ({ children }: PortalBoundaryProps): ReactElement | null => {
  const target = usePortalTarget()
  return target.available ? children(target.container) : null
}

/** Supplies a custom portal target or owns an in-tree target without assuming a global body. */
export const PortalProvider = ({ children, container }: PortalProviderProps): ReactElement => {
  const [ownedContainer, setOwnedContainer] = useState<HTMLDivElement | null>(null)
  const resolvedContainer = container === undefined ? ownedContainer : container
  const target: RlyPortalTarget =
    resolvedContainer === null ? unavailableTarget : { available: true, container: resolvedContainer }

  return (
    <PortalTargetContext.Provider value={target}>
      {children}
      {container === undefined ? <div data-rly-portal-root="" ref={setOwnedContainer} /> : null}
    </PortalTargetContext.Provider>
  )
}
