import type { ReactNode } from "react"
import { createContext, useCallback, useContext, useState } from "react"

type DialogElement = () => ReactNode

interface DialogContextValue {
  readonly current: DialogElement | null
  readonly show: (element: DialogElement) => void
  readonly hide: () => void
}

const DialogContext = createContext<DialogContextValue>({
  current: null,
  show: () => {},
  hide: () => {}
})

/**
 * Provides dialog stack management to child components
 * @category context
 */
export function DialogProvider({ children }: { readonly children: React.ReactNode }) {
  const [stack, setStack] = useState<Array<DialogElement>>([])

  const show = useCallback((element: DialogElement) => {
    setStack((s) => [...s, element])
  }, [])

  const hide = useCallback(() => {
    setStack((s) => s.slice(0, -1))
  }, [])

  const current = stack.length > 0 ? stack[stack.length - 1]! : null

  return <DialogContext.Provider value={{ current, show, hide }}>{children}</DialogContext.Provider>
}

/**
 * Hook to access dialog management functions
 * @category hooks
 * @example
 * ```tsx
 * function MyComponent() {
 *   const dialog = useDialog()
 *   return (
 *     <box onMouseUp={() => dialog.show(() => <HelpModal />)}>
 *       <text>Show Help</text>
 *     </box>
 *   )
 * }
 * ```
 */
export function useDialog(): DialogContextValue {
  return useContext(DialogContext)
}
