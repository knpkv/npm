---
"@knpkv/herdr-usage": patch
---

The Usage app starts when the hub runs it. It used to ask the hub for this machine's name while building its routes, before it listened. The hub answers an app only once it has read that app's manifest, so every start failed and the hub left Usage off as crashlooping. It now reads the machine's name only when a standalone run first reads this machine's usage.
