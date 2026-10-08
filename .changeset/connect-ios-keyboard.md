---
"@knpkv/herdr-connect": minor
---

In Connect on iPhone, a tap on the terminal now brings up the keyboard: it focuses the terminal's text input inside the tap, where Ghostty's own focus went to a container iOS won't type into. The key rail gets a Keys toggle that hides the Ctrl/Alt modifiers and the terminal keys (Select and Latest stay), remembered on this device. `TerminalKeyRail` takes optional `keysHidden` and `onKeysHiddenChange`.
