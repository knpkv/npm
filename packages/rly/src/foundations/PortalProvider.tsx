import { createContext, type ReactElement, type ReactNode, useContext, useState } from "react"

/** A controlled browser portal target supported by React and Radix portals. */
export type RlyPortalContainer = Element | DocumentFragment

export interface PortalProviderProps {
  readonly children: ReactNode
  readonly container?: RlyPortalContainer | null
}

const PortalContainerContext = createContext<RlyPortalContainer | null>(null)

/** Internal target bridge for rly overlays. Null always means no target is currently available. */
export const usePortalContainer = (): RlyPortalContainer | null => useContext(PortalContainerContext)

/** Supplies a custom portal target or owns an in-tree target without assuming a global body. */
export const PortalProvider = ({ children, container }: PortalProviderProps): ReactElement => {
  const [ownedContainer, setOwnedContainer] = useState<HTMLDivElement | null>(null)
  const resolvedContainer = container === undefined ? ownedContainer : container

  return (
    <PortalContainerContext.Provider value={resolvedContainer}>
      {children}
      {container === undefined ? <div data-rly-portal-root="" ref={setOwnedContainer} /> : null}
    </PortalContainerContext.Provider>
  )
}
