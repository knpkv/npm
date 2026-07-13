import type { ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

export const render = (node: ReactNode): HTMLElement | null => {
  document.body.innerHTML = renderToStaticMarkup(node)
  return document.body.querySelector<HTMLElement>(":scope > *")
}
