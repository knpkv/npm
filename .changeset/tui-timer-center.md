---
"@knpkv/jira-clockify": patch
---

Fix the TUI big-timer view rendering left-of-center: `useTerminalSize()` was hardcoded to 80 columns, so the ticket, digits, progress bar, and controls were centered within the leftmost 80 columns instead of the full terminal width. It now reads the live terminal width (via `useTerminalDimensions`), so the timer centers correctly and tracks resizes.
