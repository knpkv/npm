export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export const VIEW_TITLES: Record<string, string> = {
  prs: "CodeCommit PRs",
  settings: "Manage Accounts",
  notifications: "Notifications",
  details: "PR Details"
}

export const HINTS: Record<string, string> = {
  prs:
    "Enter: Details | o: Open | f: Filter | 1-4: Quick Filter | r: Refresh | s: Settings | n: Notifications | q: Quit",
  settings: "Space: Toggle | Enter: Save & Return | r: Refresh | s: PRs | t: Theme | n: Notifications | q: Quit",
  notifications: "Enter: Action | r: Refresh | s: Settings | t: Theme | c: Clear | n: PRs | q: Quit",
  details: "Esc: Back | Enter: Open/Copy"
}

export const COMMON_HELP = "  r       - Refresh everything\n" +
  "  t       - Toggle theme\n" +
  "  h       - Toggle help\n" +
  "  q       - Quit\n" +
  "  Esc     - Close help / Clear filter"

export const HELP_CONTENT = {
  prs: "  f       - Filter PRs\n" +
    "  1-4     - Quick filters (All/Mine/Account/Author)\n" +
    "  ←→      - Cycle filter values\n" +
    "  Enter   - PR Details\n" +
    "  o       - Open PR in browser\n" +
    "  s       - Manage Accounts\n" +
    "  n       - Notifications",
  settings: "  Enter   - Toggle account sync\n" +
    "  s       - Back to PRs\n" +
    "  n       - Notifications",
  notifications: "  Enter   - Run action\n" +
    "  c       - Clear all\n" +
    "  s       - Manage Accounts\n" +
    "  n       - Back to PRs"
}

export const SETTINGS_LEGEND = "\n\n" +
  "  Status Icons:\n" +
  "  ● - Active & Synced\n" +
  "  ○ - Disabled\n" +
  "  ⚠ - Error fetching"
