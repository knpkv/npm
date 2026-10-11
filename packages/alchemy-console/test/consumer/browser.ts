import { StackListView } from "@knpkv/alchemy-console/views"
import "@knpkv/alchemy-console/views/style.css"
import { createElement } from "react"
import { createRoot } from "react-dom/client"
import { props } from "./views.js"

const root = document.getElementById("root")
if (root !== null) {
  createRoot(root).render(createElement(StackListView, {
    ...props,
    state: { _tag: "Ready", list: { stacks: [], issues: [] }, checkedAt: "12:00" }
  }))
}
