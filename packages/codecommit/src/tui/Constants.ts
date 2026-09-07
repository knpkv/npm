export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export const VIEW_TITLES = {
  prs: "Pull requests",
  settings: "Settings",
  notifications: "Notifications",
  details: "Pull request"
} satisfies Record<string, string>

export const HINTS = {
  prs: "enter details   o managed review   / filter   1–9 filters   r refresh   n notifications   : commands",
  settings: "tab section   1–4 jump   esc back   : commands",
  notifications: "enter action   r refresh   esc back   : commands",
  details:
    "j/k files   [/] findings   u unresolved   d discuss   V verify   m target   p/a/x decide   C console   esc back"
} satisfies Record<string, string>
