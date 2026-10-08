---
"@knpkv/codecommit-core": minor
"@knpkv/codecommit-web": minor
---

A pull request URL for a switched-off account no longer spins on "Loading pull request" while every refresh returns 500. `refreshSinglePR` fails with `AccountSwitchedOff` (naming the profile) when a disabled profile owns the account, or with `AccountUnknown` when no profile is known to; the web API answers those with 409 and 404. The page says why it can't read the pull request, links to Settings → Accounts when that fixes it, and offers Try again for any other failure.
