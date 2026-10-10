---
"@knpkv/control-center": minor
---

Live event streams now re-check their session with a validation-only lookup (token, revocation, idle and absolute expiry) that records no activity. A browser tab left open no longer keeps an idle session alive past its 12-hour idle limit. Adds `Auth.validateSession` and the `validate-session` persistence operation.
