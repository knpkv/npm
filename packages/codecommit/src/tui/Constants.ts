export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export const VIEW_TITLES: Record<string, string> = {
  prs: "CodeCommit PRs",
  settings: "Settings",
  notifications: "Notifications",
  details: "PR Details"
}

export const HINTS: Record<string, string> = {
  prs: "Enter: Details | /: Filter | 1-9: Quick Filter | r: Refresh | n: Notif | [:] Commands",
  settings: "Tab: Switch Section | 1-4: Jump | Esc: Back | [:] Commands",
  notifications: "Enter: Action | r: Refresh | Esc: Back | [:] Commands",
  details: "j/k: Files | 1/2: Changes/Comments | r/s/t/e: Relay | w: Worktree | o: Open | Esc: Back"
}
