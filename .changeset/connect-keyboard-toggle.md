---
"@knpkv/herdr-connect": minor
---

Connect's key rail has a Keyboard button: press it to bring up the on-screen keyboard (it focuses the terminal's input inside the tap, so iOS opens it), press again to put it away. It stays pressed while the keyboard is up, including after a tap on the terminal. On a phone the "N lines back" status is now a badge over the terminal's top corner rather than a rail cell, so it never resizes the terminal and taps go through it. `TerminalKeyRail` takes optional `keyboardOpen` and `onKeyboardToggle`.
