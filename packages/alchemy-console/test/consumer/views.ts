/** Built package-name consumer: declaration dependencies must survive Vite's output cleanup. */
import { type StackListState, StackListView, type StackListViewProps } from "@knpkv/alchemy-console/views"
import { createElement } from "react"

export const state: StackListState = { _tag: "Loading" }
export const props: StackListViewProps = {
  state,
  copy: {
    product: "Console",
    signInInstruction: "Run alchemy-console login for a fresh link."
  },
  onReadAgain: () => undefined
}
export const view = createElement(StackListView, props)
