---
"@knpkv/herdr-connect": minor
---

Connect's key rail has a Paste button. It reads the clipboard inside the tap (iOS asks to confirm) and sends the text to the terminal as one paste, bracketed when the program asked for it; a latched Ctrl or Alt is released first. An empty clipboard, a refused read or a browser without clipboard access says so in the rail. On phones the pinned actions sit five to a row. `TerminalKeyRail` takes an optional `onPaste`.
