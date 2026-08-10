import type { QuickFilterType } from "./atoms/ui.js"

export interface QuickFilterCommand {
  readonly label: string
  readonly shortcut: string
  readonly type: QuickFilterType
}

/** Shared by keyboard navigation and the command palette. */
export const quickFilterCommands: ReadonlyArray<QuickFilterCommand> = Object.freeze([
  { type: "all", label: "All PRs", shortcut: "1" },
  { type: "hot", label: "Hot PRs", shortcut: "2" },
  { type: "mine", label: "My PRs", shortcut: "3" },
  { type: "account", label: "By Account", shortcut: "4" },
  { type: "author", label: "By Author", shortcut: "5" },
  { type: "scope", label: "By Scope", shortcut: "6" },
  { type: "date", label: "By Age", shortcut: "7" },
  { type: "repo", label: "By Repo", shortcut: "8" },
  { type: "status", label: "By Status", shortcut: "9" }
])

export const quickFilterTypeForShortcut = (shortcut: string): QuickFilterType | undefined =>
  quickFilterCommands.find((command) => command.shortcut === shortcut)?.type
