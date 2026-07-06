---
"@knpkv/jira-clockify": patch
---

Fix the TUI stop confirmation popup: action buttons stacked vertically and overflowed the dialog box because the button row lacked `flexDirection: "row"`. Multiple buttons (e.g. "Edit end" + "Keep now", or "Retry" + "OK") now sit side by side inside the box.
