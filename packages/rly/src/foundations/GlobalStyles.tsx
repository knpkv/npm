import { Slot } from "radix-ui"
import { cloneElement, type ComponentPropsWithRef, type ReactElement, type ReactNode } from "react"

type RootProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  readonly "data-rly-root"?: string
}

export interface GlobalStylesRootProps extends RootProps {
  readonly asChild?: false
  readonly children?: ReactNode
}

export interface GlobalStylesChildProps extends RootProps {
  readonly asChild: true
  readonly children: ReactElement<RootProps>
}

/** Props for the structural boundary targeted by rly's reset and base layers. */
export type GlobalStylesProps = GlobalStylesRootProps | GlobalStylesChildProps

/** Establishes rly's style scope without injecting CSS or reading browser globals. */
export const GlobalStyles = (componentProps: GlobalStylesProps): ReactElement => {
  const { asChild, children, ...props } = componentProps
  if (asChild) {
    return <Slot.Root {...props}>{cloneElement(children, { "data-rly-root": "" })}</Slot.Root>
  }
  return (
    <div {...props} data-rly-root="">
      {children}
    </div>
  )
}
