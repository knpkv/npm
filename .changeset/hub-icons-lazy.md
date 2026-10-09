---
"@knpkv/herdr-approvals": patch
---

hostd no longer fails to start when an install lacks the Relay PNG icons. It reads each icon when a browser asks for it and answers 404 when the file is missing, so the manifest's SVG icon covers it. Installing the icon later needs no restart.
