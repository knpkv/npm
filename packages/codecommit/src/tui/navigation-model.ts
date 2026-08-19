import type { TuiView } from "./atoms/ui.js"

/** Whether the global slash/f shortcut may enter the pull-request filter. */
export const shouldOpenPullRequestFilter = (view: TuiView): boolean => view === "prs" || view === "notifications"

/** Whether the generic list handler owns Enter for the current view. */
export const shouldHandleListSelection = (view: TuiView): boolean => view !== "settings"
