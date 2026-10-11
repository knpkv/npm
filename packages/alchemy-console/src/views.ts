/** Browser presentation only. Callers own authentication, reads, navigation and shell styling. */
export type {
  OutputPresentation,
  ResourcePresentation,
  StackDetailState,
  StackPresentation,
  StackTab
} from "./presentation/detail-model.js"
export { ResourceDetailView } from "./presentation/ResourceDetailView.js"
export type { ResourceDetailViewProps } from "./presentation/ResourceDetailView.js"
export { StackDetailView } from "./presentation/StackDetailView.js"
export type { StackDetailViewProps } from "./presentation/StackDetailView.js"
export { StackListView } from "./presentation/StackListView.js"
export type { StackListCopy, StackListState, StackListViewProps } from "./presentation/StackListView.js"
