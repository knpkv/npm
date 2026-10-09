---
"@knpkv/herdr-approvals": minor
---

hostd no longer fails to start when an install lacks the Relay PNG icons. It reads each icon when a browser asks for it and answers 404 when the file is missing, so the manifest's SVG icon covers it. Installing the icon later needs no restart.

Breaking for code that builds its own `UiAssets` for `startHttpServer`: the `icons` map is replaced by `icon(file)`, which returns a promise of the PNG's bytes, or `null` when the file is unknown or missing.
