import "@knpkv/rly/styles.css"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { Scaffold } from "./Scaffold.js"

const rootElement = document.querySelector<HTMLElement>("#root")

if (rootElement === null) {
  throw new Error("Control Center requires a #root element")
}

createRoot(rootElement).render(
  <StrictMode>
    <Scaffold />
  </StrictMode>
)
