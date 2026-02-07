import { useCallback, useState } from "react"

/**
 * Hook for dismissable UI elements (dialogs, banners) with localStorage persistence.
 * Returns whether to show the element and controls to dismiss it permanently.
 */
export function useDismissable(storageKey: string) {
  const [visible, setVisible] = useState(false)
  const [dontRemind, setDontRemind] = useState(false)

  const isDismissed = () => localStorage.getItem(storageKey) === "true"

  const show = useCallback(() => {
    if (isDismissed()) return false
    setVisible(true)
    return true
  }, [storageKey])

  const dismiss = useCallback(() => {
    if (dontRemind) {
      localStorage.setItem(storageKey, "true")
    }
    setVisible(false)
  }, [dontRemind, storageKey])

  const cancel = useCallback(() => {
    setVisible(false)
  }, [])

  return { cancel, dismiss, dontRemind, isDismissed, setDontRemind, show, visible } as const
}
