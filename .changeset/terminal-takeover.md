---
"@knpkv/herdr-connect": minor
"@knpkv/herdr-hub": minor
---

Add explicit terminal takeover across devices. A controlled terminal offers Take over, including when all four controller slots are occupied; the previous device shows Taken over on another device with Reconnect. Keep Connecting during bounded cleanup and cancel pending admission when the stage closes. Preserve recovery-dialog focus through directory refreshes. Require fresh authenticated remote-host capability before forwarding takeover, preserving the controlled state on older hosts. Export optional takeover selection and the capability and takeover-close schemas.

Ordinary reconnects wait for a closing controller's bounded release instead of being refused as already controlled. Live controllers remain exclusive; cancellation and newer takeovers retain the same cleanup barrier.
