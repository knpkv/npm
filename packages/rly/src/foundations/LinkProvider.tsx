"use client"

import { createContext, type ComponentPropsWithRef, type ComponentType, type ReactNode, useContext } from "react"

/** Standard anchor properties with a required destination and ref support. */
export type RlyLinkProps = Omit<ComponentPropsWithRef<"a">, "href"> & {
  readonly href: string
}

/** Framework-neutral link component accepted by {@link LinkProvider}. */
export type RlyLinkComponent = ComponentType<RlyLinkProps>

/** Properties for installing an application-owned link bridge. */
export interface LinkProviderProps {
  readonly children: ReactNode
  readonly component: RlyLinkComponent
}

const NativeAnchor: RlyLinkComponent = (props) => <a {...props} />

const LinkComponentContext = createContext<RlyLinkComponent>(NativeAnchor)

/** Internal consumer hook for rly components that need the configured link bridge. */
export const useRlyLinkComponent = (): RlyLinkComponent => useContext(LinkComponentContext)

/** Install a framework-owned link component without coupling rly to a router. */
export const LinkProvider = ({ children, component }: LinkProviderProps) => (
  <LinkComponentContext.Provider value={component}>{children}</LinkComponentContext.Provider>
)

/** Render through the configured link bridge, falling back to a native anchor. */
export const RlyLink: RlyLinkComponent = (props) => {
  const LinkComponent = useRlyLinkComponent()

  return <LinkComponent {...props} />
}
