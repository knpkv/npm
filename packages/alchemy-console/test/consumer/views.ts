/** Built package-name consumer: declaration dependencies must survive Vite's output cleanup. */
import { createElement } from "react"

import {
  PlanView,
  type PlanViewProps,
  ResourceDetailView,
  type ResourceDetailViewProps,
  type StackDetailState,
  StackDetailView,
  type StackDetailViewProps,
  type StackListState,
  StackListView,
  type StackListViewProps,
  type StackTab
} from "@knpkv/alchemy-console/views"
import { api, detailStack } from "./detail-fixtures.js"

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
export const detailState: StackDetailState = { _tag: "Ready", stack: detailStack }
export const tab: StackTab = "resources"
export const detailProps: StackDetailViewProps = {
  state: detailState,
  copy: props.copy,
  tab,
  onTabChange: () => undefined,
  onReadAgain: () => undefined,
  resourceHref: () => "?fixture=6e"
}
export const resourceProps: ResourceDetailViewProps = {
  stack: detailStack,
  resource: api,
  copy: props.copy,
  stackHref: "?fixture=6a",
  resourceHref: () => "?fixture=6e"
}
export const detailView = createElement(StackDetailView, detailProps)
export const resourceView = createElement(ResourceDetailView, resourceProps)

export const planProps: PlanViewProps = { state: { _tag: "NotConnected" }, onReadAgain: () => undefined }
export const planView = createElement(PlanView, planProps)
