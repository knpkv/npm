---
"@knpkv/codecommit": minor
"@knpkv/codecommit-core": minor
"@knpkv/codecommit-web": minor
---

Hide pull requests of accounts you switched off. Their rows stay cached, so re-enabling an account brings its pull requests back without a provider round trip, and a URL naming one still resolves — the TUI list, the web queue, and its filter sidebar simply stop listing them, and the review badge stops counting them.
