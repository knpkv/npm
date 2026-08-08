import type { TuiView } from "./atoms/ui.js"

/** Whether the global slash/f shortcut may enter the pull-request filter. */
export const shouldOpenPullRequestFilter = (view: TuiView): boolean => view === "prs" || view === "notifications"
